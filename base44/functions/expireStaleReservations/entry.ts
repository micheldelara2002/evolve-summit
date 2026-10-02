import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { deterministicCompare } from "../../shared/deterministicSurvivor.ts";
import { releaseCheckoutLock } from "../../shared/checkoutLock.ts";
import { cancelPaymentIntent, retrievePaymentIntent, retrieveRefundWithCharge, createRefund } from "../../shared/stripeClient.ts";
import { releaseReservations, releaseCouponUse, fulfillOrder, FULFILLING_STALE_MS, applyConfirmedStripeRefund, unlockTicketsForRefund } from "../../shared/commerceFulfillment.ts";
import { dispatchCampaignCore } from "../../shared/campaignDispatch.ts";

// P2/P3 — Expira checkouts abandonados: pedidos 'pending' cuja reserva venceu
// (reserved_until — janela de 15 min do checkout).
//
// CRÍTICA 1 — Antes de expirar, checa TODOS os pagamentos do pedido (não só os
// 'pending'): um pagamento 'succeeded' (ou em fulfillment pending_retry/fulfilled)
// mantém o pedido de pé — o job NUNCA cancela um pedido pago. Nesse caso o pedido
// é promovido a 'paid' (se ainda pendente), a decisão vai para o log de auditoria
// e a emissão pendente (pending_retry) aparece na aba de transações com o botão
// de retry.
//
// Para pedidos realmente abandonados: consulta o PaymentIntent no Stripe ANTES
// de expirar cada pagamento pendente — se acabou de pagar ou está processando,
// o pedido fica intacto e o webhook faz o fulfillment. Caso contrário: cancela
// a intenção, marca pagamentos 'expired', cancela o pedido e devolve as
// quantidades reservadas aos lotes (guarda quantity_reserved >= 1 — reserved
// nunca fica negativo). Os itens são marcados is_deleted para que o webhook
// payment_intent.canceled posterior não devolva a reserva duas vezes.
//
// Também roda o RECONCILER DE EMISSÃO (P3): pagamentos 'succeeded' cujo
// fulfillment não concluiu são comparados com os ingressos emitidos × itens do
// pedido — emissão pela metade (crash intermediário) vira 'pending_retry'
// (visível na aba de transações com retry); emissão completa com status
// esquecido é concluída para 'fulfilled' (completa = cada item com ingresso
// E cada ingresso com participante vinculado).
//
// Também roda o RECONCILER DE ESTORNOS: RefundRequests 'pending' há mais de
// 15 min consultam o refund no Stripe pelo stripe_refund_id — 'succeeded' é
// processado com a mesma lógica idempotente do webhook (cobertura quando o
// webhook charge.refunded não chega); 'failed'/'canceled' marca a falha e
// devolve a reserva do teto de estorno.
//
// MODELO M2M (2026-09-29) — endpoint PÚBLICO seguro-por-construção, no mesmo
// padrão do stripeWebhook: chamadas de máquina (workflow agendado) não têm
// contexto de usuário; a função roda INTEIRA em service role. Segurança por
// construção: operações idempotentes/convergentes (CAS por toda parte),
// resposta sem PII (apenas contadores), limites por execução e limitador de
// frequência (PlatformSetting 'maintenance', CAS sobre value_json) que garante
// uma única execução real em corridas e rejeita chamadas com menos de 4 min da
// última rodada — devolvendo o resumo da última execução (HTTP 200).
//
// Cupons: o uso nunca é contabilizado na criação do pedido (só no fulfillment),
// então pedidos expirados não consomem cupom — nada a devolver aqui.

const MAX_ORDERS_PER_RUN = 50;
const MAINTENANCE_THROTTLE_MS = 4 * 60 * 1000; // janela mínima entre execuções
const MAX_RECONCILE_PER_RUN = 25;
const MAX_REFUND_RECONCILE_PER_RUN = 25;

// Campanhas agendadas (P2 2026-09-29) — a mesma varredura dispara campanhas
// 'scheduled' vencidas e retoma disparos automáticos interrompidos, sem
// depender do navegador do operador. Permissão CONFIADA no agendamento (regra
// aprovada). Orçamento próprio por disparo + teto por rodada + teto de
// tentativas (falhas NÃO reassumíveis) — ver reconciler de campanhas abaixo.
const MAX_CAMPAIGNS_PER_RUN = 2;
const CAMPAIGN_DISPATCH_BUDGET_MS = 8_000;
const CAMPAIGN_SWEEP_MAX_ELAPSED_MS = 15_000; // só roda se a rodada ainda está no começo
const MAX_AUTO_DISPATCH_ATTEMPTS = 5;

// Reconciler de resgates (P2 2026-09-29) — drift do contador redeemed_total.
const REDEMPTION_PAGE_SIZE = 500;
const MAX_REDEMPTION_SCAN_PER_RUN = 2000;
const MAX_REDEMPTION_FIXES_PER_RUN = 100;

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);

    // TEMP-AUD4 — diagnóstico do canal do scheduler: persiste os headers da
    // requisição (com segredos redigidos) em PlatformSetting 'req_meta_diag'
    // para descobrir um marcador distinguível da invocação agendada antes de
    // ativar o gate M2M. Antes do throttle — captura mesmo runs throttled.
    try {
      const svcDiag = base44.asServiceRole;
      const hdrsDiag: Record<string, string> = {};
      req.headers.forEach((v: string, k: string) => {
        const kl = k.toLowerCase();
        hdrsDiag[kl] = /cookie|auth|key|token|secret/.test(kl) ? '[redacted]' : v;
      });
      const meta = JSON.stringify({ url: req.url, method: req.method, headers: hdrsDiag, at: new Date().toISOString() });
      const existing = (await svcDiag.entities.PlatformSetting.filter({ key: 'req_meta_diag' }))[0];
      if (existing) {
        await svcDiag.entities.PlatformSetting.update(existing.id, { value_json: meta });
      } else {
        await svcDiag.entities.PlatformSetting.create({ key: 'req_meta_diag', value_json: meta });
      }
    } catch {}

    // ===== Limitador de frequência (anti-abuso do endpoint público) =====
    // PlatformSetting 'maintenance' guarda { last_run_at, summary }. CAS sobre
    // o value_json: corridas concorrentes do scheduler resultam em exatamente
    // UMA execução real; chamadas com menos de 4 min da última rodada recebem
    // HTTP 200 com o resumo anterior, sem reprocessar (nem auditar — evita
    // spam de log).
    const svc = base44.asServiceRole;
    const nowIso = new Date().toISOString();
    const runStartMs = Date.now();
    const existingSettings = await svc.entities.PlatformSetting.filter({ key: 'maintenance' });
    let maintenanceSetting: any = existingSettings[0] || null;
    let lastRun: any = null;
    try { lastRun = JSON.parse(maintenanceSetting?.value_json || 'null'); } catch { lastRun = null; }
    const lastRunAtMs = lastRun?.last_run_at ? new Date(lastRun.last_run_at).getTime() : 0;
    if (maintenanceSetting && lastRunAtMs && Date.now() - lastRunAtMs < MAINTENANCE_THROTTLE_MS) {
      return Response.json({ ok: true, throttled: true, last_run_at: lastRun.last_run_at, ...(lastRun.summary || {}) });
    }
    // Cursor do reconciler de resgates sobrevive ao claim (varredura contínua).
    const claimedJson = JSON.stringify({ last_run_at: nowIso, summary: lastRun?.summary || null, redemption_skip: Number(lastRun?.redemption_skip) || 0 });
    if (maintenanceSetting) {
      const claim = await svc.entities.PlatformSetting.updateMany(
        { key: 'maintenance', value_json: maintenanceSetting.value_json },
        { $set: { value_json: claimedJson } }
      );
      if (!claim || !claim.updated) {
        return Response.json({ ok: true, throttled: true, last_run_at: lastRun?.last_run_at || '' });
      }
    } else {
      // Primeira execução — cria a config. Corrida de creates concorrentes:
      // sobrevivente determinístico segue; o perdedor responde throttled.
      const created = await svc.entities.PlatformSetting.create({ key: 'maintenance', value_json: claimedJson });
      const records = await svc.entities.PlatformSetting.filter({ key: 'maintenance' });
      if (records.length > 1) {
        records.sort(deterministicCompare);
        if (records[0].id !== created.id) {
          return Response.json({ ok: true, throttled: true });
        }
        for (let i = 1; i < records.length; i++) {
          try { await svc.entities.PlatformSetting.delete(records[i].id); } catch {}
        }
      }
      maintenanceSetting = created;
    }

    // PERF-003 — a query já é LIMITADA no banco (antes: carregava TODOS os
    // pedidos vencidos e só depois limitava o processamento a 50). Ordenação
    // determinística por reserved_until (mais antigos primeiro); limite+1
    // revela has_more sem carregar a lista inteira.
    const staleOrders = await svc.entities.Order.filter(
      {
        status: 'pending',
        is_deleted: false,
        reserved_until: { $lt: new Date().toISOString() },
      },
      'reserved_until',
      MAX_ORDERS_PER_RUN + 1
    );
    const hasMoreStale = staleOrders.length > MAX_ORDERS_PER_RUN;
    if (hasMoreStale) staleOrders.pop();

    let expired = 0;
    let keptAlive = 0;
    const limit = staleOrders.length;
    for (let i = 0; i < limit; i++) {
      const order = staleOrders[i];

      // CRÍTICA 1 — pagamento vivo em QUALQUER estado (não só 'pending'):
      // succeeded, ou em fulfillment pending_retry/fulfilled → pedido mantido
      // de pé. Reservas não são devolvidas; o dinheiro do comprador é real.
      const allPayments = await svc.entities.Payment.filter({ order_id: order.id, is_deleted: false });
      const livePayment = allPayments.find((p: any) =>
        p.status === 'succeeded' ||
        p.fulfillment_status === 'pending_retry' ||
        p.fulfillment_status === 'fulfilled'
      );
      if (livePayment) {
        keptAlive++;
        // Promove o pedido a 'paid' (o webhook pode ainda não ter chegado) —
        // também o tira da varredura de pendentes das próximas execuções.
        if (livePayment.status === 'succeeded' && order.status === 'pending') {
          try { await svc.entities.Order.update(order.id, { status: 'paid' }); } catch {}
        }
        try {
          await svc.entities.AuditLog.create({
            action: 'status_change',
            entity_type: 'Order',
            entity_id: order.id,
            details: JSON.stringify({
              type: 'stale_reservation_kept_paid',
              payment_id: livePayment.id,
              intent_id: livePayment.intent_id || '',
              payment_status: livePayment.status,
              fulfillment_status: livePayment.fulfillment_status || '',
              valor_pago: livePayment.amount || 0,
              valor_total_pedido: order.total || 0,
            }),
            event_id: order.event_id,
            user_id: order.buyer_user_id,
          });
        } catch {}
        continue;
      }

      const pendingPayments = allPayments.filter((p: any) => p.status === 'pending');

      let keepAlive = false;
      for (let j = 0; j < pendingPayments.length; j++) {
        const p = pendingPayments[j];
        const isFree = String(p.intent_id || '').startsWith('free_');
        if (!isFree) {
          let intentStatus = '';
          try { intentStatus = String((await retrievePaymentIntent(p.intent_id))?.status || ''); } catch {}
          // Não conseguiu verificar, pagou agora ou ainda processando → não expira.
          if (!intentStatus || intentStatus === 'succeeded' || intentStatus === 'processing') {
            keepAlive = true;
            break;
          }
          if (intentStatus !== 'canceled') {
            try {
              await cancelPaymentIntent(p.intent_id);
            } catch (err: any) {
              // CRÍTICO — cancelamento NÃO confirmado (Pix confirmado e em
              // 'processing' segundos antes, falha de rede, erro imprevisto):
              // o intent ainda pode ser pago. NÃO marca o pagamento nem
              // encerra o pedido — mantém tudo para a próxima varredura.
              console.error('[expireStaleReservations] cancel intent failed, keeping order alive:', err?.message || err);
              keepAlive = true;
              break;
            }
          }
        }
        // Expiração do pagamento via CAS (vale para free e Stripe): só marca
        // se ainda estiver 'pending'. Falha no CAS = outro caminho (webhook/
        // re-checkout/pagamento confirmado) já moveu o estado — não
        // sobrescreve; o pedido fica para reavaliação na próxima varredura.
        const payClaim = await svc.entities.Payment.updateMany(
          { id: p.id, status: 'pending' },
          { $set: { status: 'expired', error_reason: 'Checkout abandonado (reserva expirada).' } }
        );
        if (!payClaim || !payClaim.updated) {
          keepAlive = true;
          break;
        }
      }
      if (keepAlive) { keptAlive++; continue; }

      // Encerramento EXATAMENTE-UMA-VEZ (P0): CAS no pedido com o status E o
      // reserved_until lidos NA VARREDURA — qualquer mudança concorrente no
      // pedido (re-checkout estendeu a reserva, webhook promoveu a paid, o
      // caminho canceled do webhook já encerrou) faz a transição falhar e o
      // job pula o pedido nesta execução. Só quem executa pending→cancelled
      // devolve as reservas — nunca duas vezes (anti-oversell).
      const orderClaim = await svc.entities.Order.updateMany(
        { id: order.id, status: 'pending', reserved_until: order.reserved_until },
        { $set: { status: 'cancelled' } }
      );
      if (!orderClaim || !orderClaim.updated) continue;

      // FIN-001 — libera (idempotente) o lock de checkout do comprador: o
      // pedido pendente foi encerrado, novo checkout é permitido imediatamente.
      await releaseCheckoutLock(svc, order.buyer_person_id, order.event_id);

      const orderItems = await svc.entities.OrderItem.filter({ order_id: order.id, is_deleted: false });
      // FIN-002 — devolve o uso do cupom reservado pelo checkout abandonado.
      await releaseCouponUse(svc, order);
      await releaseReservations(svc, orderItems);
      for (let k = 0; k < orderItems.length; k++) {
        try { await svc.entities.OrderItem.update(orderItems[k].id, { is_deleted: true }); } catch {}
      }
      try {
        await svc.entities.AuditLog.create({
          action: 'status_change',
          entity_type: 'Order',
          entity_id: order.id,
          details: JSON.stringify({
            type: 'stale_reservation_expired',
            items: orderItems.length,
            valor_total: order.total || 0,
            intents_expirados: pendingPayments.map((p: any) => p.intent_id),
          }),
          event_id: order.event_id,
          user_id: order.buyer_user_id,
        });
      } catch {}
      expired++;
    }

    // ===== Reconciler de emissão: pagamentos pagos × ingressos/participantes =====
    let reconcileFlagged = 0;
    let reconcileCompleted = 0;
    try {
      const cutoff = new Date(Date.now() - FULFILLING_STALE_MS);
      const candidates = await svc.entities.Payment.filter({
        status: 'succeeded',
        is_deleted: false,
        fulfillment_status: { $in: ['pending', 'pending_retry', 'fulfilling'] },
      });
      const rcLimit = Math.min(candidates.length, MAX_RECONCILE_PER_RUN);
      for (let i = 0; i < rcLimit; i++) {
        const p = candidates[i];
        // 'fulfilling' recente = laço de emissão vivo agora (webhook/polling) —
        // não mexe; só 'fulfilling' stalo (crash) é recuperado.
        if (p.fulfillment_status === 'fulfilling' && p.updated_date && new Date(p.updated_date) > cutoff) continue;
        const items = await svc.entities.OrderItem.filter({ order_id: p.order_id, is_deleted: false });
        if (items.length === 0) continue; // pedido reutilizado sem itens — nada a comparar
        const tickets = await svc.entities.Ticket.filter({ order_id: p.order_id, is_deleted: false });
        // Emissão completa = CADA item tem ingresso E CADA ingresso tem
        // participante vinculado (CRÍTICO: crash entre criar o ingresso e
        // vincular o participante deixaria um titular com ingresso válido
        // ausente da lista de participantes — jamais selar como 'fulfilled').
        const complete = tickets.length >= items.length &&
          items.every((it: any) => tickets.some((t: any) => t.order_item_id === it.id && t.participant_id)) &&
          tickets.every((t: any) => !!t.participant_id);
        if (complete) {
          // Emissão completa com status esquecido (crash antes do update final).
          try {
            await svc.entities.Payment.update(p.id, { fulfillment_status: 'fulfilled' });
            reconcileCompleted++;
          } catch {}
          continue;
        }
        // Emissão pela metade — RECUPERA automaticamente (fulfillOrder é
        // idempotente por item): pedidos recentes (janela transiente de 2h)
        // são reemitidos na própria varredura, sem intervenção humana. Falha
        // persistente além da janela fica sinalizada para retry na aba de
        // transações — evita re-tentativa infinita de falha determinística.
        const ord = (await svc.entities.Order.filter({ id: p.order_id }))[0];
        const orderAgeMs = ord?.created_date ? Date.now() - new Date(ord.created_date).getTime() : Infinity;
        if (ord && ord.status !== 'cancelled' && orderAgeMs <= 2 * 60 * 60 * 1000) {
          const attempt = await fulfillOrder(svc, p, ord, items);
          if (attempt.fulfilled) { reconcileCompleted++; continue; }
          reconcileFlagged++; // fulfillOrder já gravou pending_retry + error_reason
          continue;
        }
        try {
          await svc.entities.Payment.update(p.id, {
            fulfillment_status: 'pending_retry',
            error_reason: 'Emissão incompleta detectada pelo reconciler agendado (ingresso sem participante vinculado ou emissão pela metade).',
          });
          reconcileFlagged++;
        } catch {}
      }
    } catch (recErr: any) {
      console.error('[expireStaleReservations] reconcile failed:', recErr?.message || recErr);
    }

    // ===== Reconciler de estornos: webhook charge.refunded não chegou =====
    // RefundRequests 'pending' há mais de 15 min com refund criado no Stripe:
    // consulta o refund pelo stripe_refund_id — 'succeeded' é processado
    // localmente com a MESMA lógica idempotente do webhook (o dinheiro voltou,
    // ingressos/participantes têm que refletir); 'failed'/'canceled' marca a
    // solicitação como falha e devolve a reserva do teto de estorno.
    let refundsReconciled = 0;
    let refundsFailed = 0;
    try {
      const refundCutoff = Date.now() - 15 * 60 * 1000;
      const pendingReqs = await svc.entities.RefundRequest.filter({ status: 'pending', is_deleted: false });
      for (let i = 0; i < pendingReqs.length; i++) {
        if (refundsReconciled + refundsFailed >= MAX_REFUND_RECONCILE_PER_RUN) break;
        const req = pendingReqs[i];
        // DAT-002 — solicitação com chave de idempotência mas SEM refund no
        // Stripe: falha de rede na criação (resposta perdida). Re-tenta com a
        // MESMA chave — se o refund existir, o Stripe devolve o MESMO objeto e
        // a solicitação é vinculada (o webhook/next pass processa); erro
        // DEFINITIVO do Stripe marca a falha e devolve teto + trava.
        if (!req.stripe_refund_id) {
          if (!req.idempotency_key) continue; // nunca disparada — só o webhook
          const isPartialReq = req.refund_type === 'partial' || req.refund_type === 'cancel_item';
          const reqAmountBRL = Number(req.amount_requested) || 0;
          const failThisRequest = async (why: string) => {
            await svc.entities.RefundRequest.update(req.id, { status: 'failed', rejection_reason: why });
            if (reqAmountBRL > 0) {
              await svc.entities.Payment.updateMany(
                { id: req.payment_id, refunded_amount: { $gte: reqAmountBRL } },
                { $inc: { refunded_amount: -reqAmountBRL } }
              );
            }
            const ord = (await svc.entities.Order.filter({ id: req.order_id }))[0];
            if (ord) await unlockTicketsForRefund(svc, ord.id, Array.isArray(req.order_item_ids) ? req.order_item_ids : undefined);
            refundsFailed++;
          };
          try {
            const p = (await svc.entities.Payment.filter({ id: req.payment_id }))[0];
            const o = (await svc.entities.Order.filter({ id: req.order_id }))[0];
            if (!p || !o) continue;
            const ref = await createRefund({
              paymentIntentId: p.intent_id,
              amountCents: isPartialReq ? Math.round(reqAmountBRL * 100) : undefined,
              idempotencyKey: req.idempotency_key,
              reverseTransfer: !!p.destination_account_id,
              refundApplicationFee: !!p.destination_account_id,
            });
            if (ref && ref.status === 'failed') {
              await failThisRequest('Estorno falhou no Stripe (reconciler — tentativa com chave idempotente).');
            } else if (ref && ref.id) {
              await svc.entities.RefundRequest.update(req.id, { stripe_refund_id: ref.id });
              refundsReconciled++;
            }
          } catch (retryErr: any) {
            if (retryErr instanceof TypeError || /fetch|network/i.test(String(retryErr?.message || ''))) {
              // Ainda indeterminado — a próxima varredura tenta de novo.
            } else {
              await failThisRequest(retryErr?.message || String(retryErr));
            }
          }
          continue;
        }
        // Janela de cortesia: webhook pode ainda chegar.
        if (req.created_date && new Date(req.created_date).getTime() > refundCutoff) continue;

        let payment: any, order: any, refunded: any;
        try {
          payment = (await svc.entities.Payment.filter({ id: req.payment_id }))[0];
          order = (await svc.entities.Order.filter({ id: req.order_id }))[0];
          if (!payment || !order) continue;
          refunded = await retrieveRefundWithCharge(req.stripe_refund_id);
        } catch (lookupErr: any) {
          console.error('[expireStaleReservations] refund lookup failed:', req.id, lookupErr?.message || lookupErr);
          continue;
        }
        // Segurança: refund de outro PaymentIntent — não processa.
        if (refunded.payment_intent !== payment.intent_id) {
          console.error('[expireStaleReservations] refund/payment mismatch:', req.id);
          continue;
        }

        if (refunded.status === 'succeeded') {
          await applyConfirmedStripeRefund(
            svc, payment, order, req,
            Number(refunded.charge?.amount_refunded) || 0,
            Number(refunded.charge?.amount) || 0
          );
          try {
            await svc.entities.AuditLog.create({
              action: 'status_change',
              entity_type: 'RefundRequest',
              entity_id: req.id,
              details: JSON.stringify({
                type: 'refund_reconciled_offline',
                stripe_refund_id: req.stripe_refund_id,
                payment_id: payment.id,
                intent_id: payment.intent_id || '',
                valor_pago: payment.amount || 0,
                valor_estornado_acumulado: (Number(refunded.charge?.amount_refunded) || 0) / 100,
                valor_solicitado: req.amount_requested || 0,
              }),
              event_id: order.event_id,
              user_id: req.requested_by_user_id,
            });
          } catch {}
          refundsReconciled++;
        } else if (refunded.status === 'failed' || refunded.status === 'canceled') {
          try {
            await svc.entities.RefundRequest.update(req.id, {
              status: 'failed',
              rejection_reason: 'Estorno não concluído no Stripe (detectado pelo reconciler agendado).',
            });
            // Devolve a reserva do teto (pré-incrementada no requestRefund).
            const reservedBRL = Number(req.amount_requested) || 0;
            if (reservedBRL > 0) {
              await svc.entities.Payment.updateMany(
                { id: req.payment_id, refunded_amount: { $gte: reservedBRL } },
                { $inc: { refunded_amount: -reservedBRL } }
              );
            }
            // Destrava os ingressos travados para este estorno (refund_pending → issued).
            await unlockTicketsForRefund(
              svc, order.id,
              Array.isArray(req.order_item_ids) ? req.order_item_ids : undefined
            );
          } catch (failErr: any) {
            console.error('[expireStaleReservations] refund fail mark failed:', req.id, failErr?.message || failErr);
          }
          refundsFailed++;
        }
        // status 'pending' no Stripe → ainda processando; próxima varredura.
      }
    } catch (refundErr: any) {
      console.error('[expireStaleReservations] refund reconcile failed:', refundErr?.message || refundErr);
    }

    // ===== Reconciler de resgates: drift do contador redeemed_total =====
    // P2 — resgates cancelados/soft-deletados FORA do fluxo (ex.: cancelamento
    // manual direto no registro) deixam Participant.redeemed_total divergido do
    // ledger (StoreRedemption). Recalcula o somatório NÃO-cancelado por
    // participante e corrige diferenças de forma idempotente (CAS $ne no valor
    // esperado — no-op quando já correto). CONVERGENTE entre rodadas via cursor
    // de varredura persistido (redemption_skip na config 'maintenance'): a
    // janela avança a cada execução e recomeça (wrap) ao atingir o fim — bases
    // grandes são cobertas integralmente ao longo das rodadas. Escaneia TODOS
    // os resgates (inclusive cancelados/deletados): participante cujo somatório
    // do ledger caiu a 0 mas cujo contador ficou >0 também é corrigido.
    let redemptionsScanned = 0;
    let redemptionFixes = 0;
    let nextRedemptionSkip = Number(lastRun?.redemption_skip) || 0;
    try {
      const sums = new Map<string, number>();
      const cursorStart = Number(lastRun?.redemption_skip) || 0;
      let scanned = 0;
      let reachedEnd = false;
      while (scanned < MAX_REDEMPTION_SCAN_PER_RUN) {
        const page = await svc.entities.StoreRedemption.filter({}, 'id', REDEMPTION_PAGE_SIZE, cursorStart + scanned);
        if (!page || page.length === 0) { reachedEnd = true; break; }
        for (let i = 0; i < page.length; i++) {
          const r = page[i];
          if (!r.participant_id) continue;
          const active = r.status !== 'cancelado' && !r.is_deleted;
          sums.set(r.participant_id, (sums.get(r.participant_id) || 0) + (active ? (r.pontos_debitados || 0) : 0));
        }
        scanned += page.length;
        if (page.length < REDEMPTION_PAGE_SIZE) { reachedEnd = true; break; }
      }
      nextRedemptionSkip = reachedEnd ? 0 : cursorStart + scanned;
      redemptionsScanned = scanned;

      const ids = Array.from(sums.keys());
      for (let i = 0; i < ids.length; i += REDEMPTION_PAGE_SIZE) {
        const chunk = ids.slice(i, i + REDEMPTION_PAGE_SIZE);
        const parts = await svc.entities.Participant.filter({ id: { $in: chunk } }, 'id', chunk.length);
        for (let j = 0; j < parts.length; j++) {
          if (redemptionFixes >= MAX_REDEMPTION_FIXES_PER_RUN) break;
          const expected = sums.get(parts[j].id) || 0;
          if ((Number(parts[j].redeemed_total) || 0) === expected) continue;
          try {
            const fix = await svc.entities.Participant.updateMany(
              { id: parts[j].id, redeemed_total: { $ne: expected } },
              { $set: { redeemed_total: expected } }
            );
            if (fix && fix.updated) redemptionFixes++;
          } catch {}
        }
      }
    } catch (redemptionErr: any) {
      console.error('[expireStaleReservations] redemption reconcile failed:', redemptionErr?.message || redemptionErr);
      nextRedemptionSkip = Number(lastRun?.redemption_skip) || 0;
    }

    // ===== Campanhas agendadas: disparo automático + retomada =====
    // 'scheduled' com scheduled_at vencido dispara AGORA (permissão confiada
    // no agendamento — regra aprovada). 'partially_sent'/'failed' de campanhas
    // AGENDADAS (scheduled_at presente) são retomadas nas execuções seguintes —
    // o encadeamento não depende do navegador do operador (mitiga o timeout da
    // campanha global). Falhas NÃO reassumíveis consomem auto_dispatch_attempts;
    // atingido o teto, a campanha fica 'failed' para retry manual. Campanhas de
    // envio imediato (sem scheduled_at) NÃO são retomadas automaticamente.
    let campaignsDispatched = 0;
    let campaignsFailed = 0;
    try {
      if (Date.now() - runStartMs < CAMPAIGN_SWEEP_MAX_ELAPSED_MS) {
        const dueScheduled = await svc.entities.NotificationCampaign.filter(
          {
            status: 'scheduled',
            is_deleted: false,
            scheduled_at: { $lte: new Date().toISOString() },
          },
          'scheduled_at',
          MAX_CAMPAIGNS_PER_RUN + 2
        );
        const candidates: any[] = [];
        for (let i = 0; i < dueScheduled.length && candidates.length < MAX_CAMPAIGNS_PER_RUN; i++) {
          if ((Number(dueScheduled[i].auto_dispatch_attempts) || 0) < MAX_AUTO_DISPATCH_ATTEMPTS) candidates.push(dueScheduled[i]);
        }
        // Retomada: apenas campanhas originalmente agendadas (scheduled_at
        // presente — envio imediato não grava o campo e não casa a query).
        if (candidates.length < MAX_CAMPAIGNS_PER_RUN) {
          const resumable = await svc.entities.NotificationCampaign.filter(
            {
              status: { $in: ['partially_sent', 'failed'] },
              is_deleted: false,
              scheduled_at: { $gte: '1970-01-01T00:00:00.000Z' },
            },
            'scheduled_at',
            MAX_CAMPAIGNS_PER_RUN + 2
          );
          for (let i = 0; i < resumable.length && candidates.length < MAX_CAMPAIGNS_PER_RUN; i++) {
            if ((Number(resumable[i].auto_dispatch_attempts) || 0) < MAX_AUTO_DISPATCH_ATTEMPTS) candidates.push(resumable[i]);
          }
        }

        for (let i = 0; i < candidates.length; i++) {
          if (Date.now() - runStartMs >= CAMPAIGN_SWEEP_MAX_ELAPSED_MS) break;
          const c = candidates[i];
          // Emissor: resolvido do sender_user_id (o disparo é service role).
          // Conta excluída → senderUser null: audiências de parceiro/palestrante
          // que dependem dele resolvem vazio; o envio prossegue (regra do
          // agendamento confiável).
          let senderUser: any = null;
          if (c.sender_user_id) {
            try { senderUser = (await svc.entities.User.filter({ id: c.sender_user_id }))[0] || null; } catch {}
          }
          // Audiências de parceiro: partner_id persistido no agendamento
          // (audience_payload JSON {partner_id}).
          let senderPartnerId: string | null = null;
          if (c.audience_type === 'my_leads' || c.audience_type === 'partner_leads') {
            try { senderPartnerId = JSON.parse(c.audience_payload || '{}').partner_id || null; } catch { senderPartnerId = null; }
          }
          try {
            const r = await dispatchCampaignCore(svc, {
              campaign: c,
              senderUser,
              senderPartnerId,
              auditUserId: c.sender_user_id || 'system',
              timeBudgetMs: CAMPAIGN_DISPATCH_BUDGET_MS,
            });
            if (r.ok) {
              campaignsDispatched++;
              continue;
            }
            if (r.claimed) {
              // Falha — só consome tentativa se NÃO for reassumível (rodadas
              // encerradas por orçamento têm has_more e continuam na próxima).
              if (!r.has_more) {
                try {
                  await svc.entities.NotificationCampaign.updateMany({ id: c.id }, { $inc: { auto_dispatch_attempts: 1 } });
                } catch {}
              }
              campaignsFailed++;
            }
            // !claimed → outro dispatcher (manual/agendado concorrente) venceu
            // o claim; ignora silenciosamente.
          } catch (campaignErr: any) {
            console.error('[expireStaleReservations] campaign dispatch failed:', c.id, campaignErr?.message || campaignErr);
            try { await svc.entities.NotificationCampaign.updateMany({ id: c.id }, { $inc: { auto_dispatch_attempts: 1 } }); } catch {}
            campaignsFailed++;
          }
        }
      }
    } catch (campaignSweepErr: any) {
      console.error('[expireStaleReservations] campaign sweep failed:', campaignSweepErr?.message || campaignSweepErr);
    }

    // Resumo da rodada persistido na config (resposta das chamadas throttled)
    // + auditoria da execução real (sem PII — apenas contadores).
    const summary = {
      checked: limit,
      expired,
      kept_alive: keptAlive,
      reconcile_flagged: reconcileFlagged,
      reconcile_completed: reconcileCompleted,
      refunds_reconciled: refundsReconciled,
      refunds_failed: refundsFailed,
      // Aproximação com a query limitada: 1 = ainda há vencidos além deste
      // lote (próxima varredura pega), 0 = varredura completa.
      remaining: hasMoreStale ? 1 : 0,
      // Reconciler de resgates (P2 2026-09-29) — sem PII, apenas contadores.
      redemptions_scanned: redemptionsScanned,
      redemption_fixes: redemptionFixes,
      // Campanhas agendadas (P2 2026-09-29).
      campaigns_dispatched: campaignsDispatched,
      campaigns_failed: campaignsFailed,
    };
    if (maintenanceSetting) {
      try {
        await svc.entities.PlatformSetting.update(maintenanceSetting.id, {
          value_json: JSON.stringify({ last_run_at: nowIso, summary, redemption_skip: nextRedemptionSkip }),
        });
      } catch {}
    }
    try {
      await svc.entities.AuditLog.create({
        action: 'status_change',
        entity_type: 'Order',
        entity_id: '',
        details: JSON.stringify({ type: 'maintenance_run', ...summary }),
        event_id: '',
        user_id: 'system',
        user_name: 'Manutenção automática',
      });
    } catch {}

    return Response.json({ ok: true, ...summary });
  } catch (error: any) {
    console.error('[expireStaleReservations]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
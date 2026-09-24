import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { cancelPaymentIntent, retrievePaymentIntent, retrieveRefundWithCharge } from "../../shared/stripeClient.ts";
import { releaseReservations, FULFILLING_STALE_MS, applyConfirmedStripeRefund, unlockTicketsForRefund } from "../../shared/commerceFulfillment.ts";

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
// Chamado pelo workflow agendado "Expirar Reservas Abandonadas" (sem usuário
// autenticado). Chamadas diretas autenticadas exigem admin.
//
// Cupons: o uso nunca é contabilizado na criação do pedido (só no fulfillment),
// então pedidos expirados não consomem cupom — nada a devolver aqui.

const MAX_ORDERS_PER_RUN = 50;
const MAX_RECONCILE_PER_RUN = 25;
const MAX_REFUND_RECONCILE_PER_RUN = 25;

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    let user: any = null;
    try { user = await base44.auth.me(); } catch {}
    if (user && user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão.' }, { status: 403 });
    }
    const svc = base44.asServiceRole;

    const staleOrders = await svc.entities.Order.filter({
      status: 'pending',
      is_deleted: false,
      reserved_until: { $lt: new Date().toISOString() },
    });

    let expired = 0;
    let keptAlive = 0;
    const limit = Math.min(staleOrders.length, MAX_ORDERS_PER_RUN);
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

      const orderItems = await svc.entities.OrderItem.filter({ order_id: order.id, is_deleted: false });
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
        // Emissão pela metade — sinaliza para recuperação na aba de transações.
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
        // Sem refund no Stripe (ainda não disparado) — só o webhook pode casar.
        if (!req.stripe_refund_id) continue;
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

    return Response.json({
      ok: true,
      checked: limit,
      expired,
      kept_alive: keptAlive,
      reconcile_flagged: reconcileFlagged,
      reconcile_completed: reconcileCompleted,
      refunds_reconciled: refundsReconciled,
      refunds_failed: refundsFailed,
      remaining: Math.max(0, staleOrders.length - limit),
    });
  } catch (error: any) {
    console.error('[expireStaleReservations]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
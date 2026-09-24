import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { cancelPaymentIntent, retrievePaymentIntent } from "../../shared/stripeClient.ts";
import { releaseReservations, FULFILLING_STALE_MS } from "../../shared/commerceFulfillment.ts";

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
// esquecido é concluída para 'fulfilled'.
//
// Chamado pelo workflow agendado "Expirar Reservas Abandonadas" (sem usuário
// autenticado). Chamadas diretas autenticadas exigem admin.
//
// Cupons: o uso nunca é contabilizado na criação do pedido (só no fulfillment),
// então pedidos expirados não consomem cupom — nada a devolver aqui.

const MAX_ORDERS_PER_RUN = 50;
const MAX_RECONCILE_PER_RUN = 25;

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
              payment_status: livePayment.status,
              fulfillment_status: livePayment.fulfillment_status || '',
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
              if (/succeeded|captured/i.test(String(err?.message || ''))) {
                keepAlive = true; // pagou entre a consulta e o cancelamento — webhook cuida
                break;
              }
            }
          }
        }
        await svc.entities.Payment.update(p.id, {
          status: 'expired',
          error_reason: 'Checkout abandonado (reserva expirada).',
        });
      }
      if (keepAlive) { keptAlive++; continue; }

      const orderItems = await svc.entities.OrderItem.filter({ order_id: order.id, is_deleted: false });
      await releaseReservations(svc, orderItems);
      for (let k = 0; k < orderItems.length; k++) {
        try { await svc.entities.OrderItem.update(orderItems[k].id, { is_deleted: true }); } catch {}
      }
      await svc.entities.Order.update(order.id, { status: 'cancelled' });
      try {
        await svc.entities.AuditLog.create({
          action: 'status_change',
          entity_type: 'Order',
          entity_id: order.id,
          details: JSON.stringify({ type: 'stale_reservation_expired', items: orderItems.length }),
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
        if (tickets.length >= items.length) {
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
            error_reason: 'Emissão incompleta detectada pelo reconciler agendado (crash intermediário).',
          });
          reconcileFlagged++;
        } catch {}
      }
    } catch (recErr: any) {
      console.error('[expireStaleReservations] reconcile failed:', recErr?.message || recErr);
    }

    return Response.json({
      ok: true,
      checked: limit,
      expired,
      kept_alive: keptAlive,
      reconcile_flagged: reconcileFlagged,
      reconcile_completed: reconcileCompleted,
      remaining: Math.max(0, staleOrders.length - limit),
    });
  } catch (error: any) {
    console.error('[expireStaleReservations]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
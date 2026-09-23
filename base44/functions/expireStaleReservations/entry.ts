import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { cancelPaymentIntent, retrievePaymentIntent } from "../../shared/stripeClient.ts";
import { releaseReservations } from "../../shared/commerceFulfillment.ts";

// P2 — Expira checkouts abandonados: pedidos 'pending' cuja reserva venceu
// (reserved_until — janela de 15 min do checkout). Para cada pagamento pendente,
// consulta o PaymentIntent no Stripe ANTES de expirar: se o pagamento acabou de
// ter sucesso (ou está processando), o pedido fica intacto e o webhook faz o
// fulfillment. Caso contrário: cancela a intenção, marca pagamentos 'expired',
// cancela o pedido e devolve as quantidades reservadas aos lotes. Os itens são
// marcados is_deleted para que o webhook payment_intent.canceled posterior não
// devolva a reserva duas vezes.
//
// Chamado pelo workflow agendado "Expirar Reservas Abandonadas" (sem usuário
// autenticado). Chamadas diretas autenticadas exigem admin.
//
// Cupons: o uso nunca é contabilizado na criação do pedido (só no fulfillment),
// então pedidos expirados não consomem cupom — nada a devolver aqui.

const MAX_ORDERS_PER_RUN = 50;

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
      const pendingPayments = await svc.entities.Payment.filter({ order_id: order.id, status: 'pending' });

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

    return Response.json({
      ok: true,
      checked: limit,
      expired,
      kept_alive: keptAlive,
      remaining: Math.max(0, staleOrders.length - limit),
    });
  } catch (error: any) {
    console.error('[expireStaleReservations]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
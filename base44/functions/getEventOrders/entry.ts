import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

// Visão detalhada de vendas de um evento: pedidos pagos com itens, titulares,
// ticket_id, hash_code, status e comprador (buyer_name/email). "Quem comprou
// o quê, quando e quanto pagou." Admin ou gerente do evento.
//
// Payload: { eventId }

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { eventId } = body;
    if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });

    const { authorized } = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!authorized) return Response.json({ error: 'Sem permissão para este evento.' }, { status: 403 });

    const svc = base44.asServiceRole;

    const [orders, payments, items, tickets] = await Promise.all([
      svc.entities.Order.filter({ event_id: eventId }, '-created_date', 10000),
      svc.entities.Payment.filter({ event_id: eventId, is_deleted: false }, undefined, 10000),
      svc.entities.OrderItem.filter({ event_id: eventId, is_deleted: false }, undefined, 10000),
      svc.entities.Ticket.filter({ event_id: eventId, is_deleted: false }, undefined, 10000),
    ]);

    const itemByOrder = new Map<string, any[]>();
    for (const it of items) {
      const arr = itemByOrder.get(it.order_id) || [];
      arr.push(it);
      itemByOrder.set(it.order_id, arr);
    }
    const ticketByItem = new Map<string, any>();
    for (const t of tickets) ticketByItem.set(t.order_item_id, t);
    const payByOrder = new Map<string, any>();
    for (const p of payments) payByOrder.set(p.order_id, p);

    const detailed = orders.map((o: any) => {
      const oItems = (itemByOrder.get(o.id) || []).map((it: any) => {
        const tk = ticketByItem.get(it.id);
        return {
          id: it.id,
          ticket_type_name: it.ticket_type_name,
          lot_id: it.lot_id,
          holder_name: it.holder_name,
          holder_email: it.holder_email,
          holder_phone: it.holder_phone || '',
          unit_price: it.unit_price,
          refunded: !!it.refunded,
          ticket_id: tk?.id || '',
          hash_code: tk?.hash_code || '',
          ticket_status: tk?.status || '',
          used_at: tk?.used_at || '',
        };
      });
      const payment = payByOrder.get(o.id);
      return {
        id: o.id,
        buyer_name: o.buyer_name,
        buyer_email: o.buyer_email,
        status: o.status,
        total: o.total,
        subtotal: o.subtotal,
        discount: o.discount,
        coupon_code: o.coupon_code,
        created_date: o.created_date,
        payment_status: payment?.status || '',
        payment_method: payment?.payment_method || '',
        intent_id: payment?.intent_id || '',
        payment_id: payment?.id || '',
        items: oItems,
      };
    });

    return Response.json({ orders: detailed, total: detailed.length });
  } catch (error: any) {
    console.error('[getEventOrders]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
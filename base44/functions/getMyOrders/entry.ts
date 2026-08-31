import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

// Returns the caller's own Orders (+ OrderItems + Tickets) and optionally a single
// order detail. Participant-side read — RLS would also gate, but this function
// assembles the joined view cleanly.
//
// Payload: { orderId? }  — if omitted, lists all the caller's orders.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const body = await req.json().catch(() => ({}));
    const { orderId } = body;

    if (orderId) {
      const order = (await svc.entities.Order.filter({ id: orderId }))[0];
      if (!order || order.buyer_user_id !== user.id) {
        return Response.json({ error: "Pedido não encontrado." }, { status: 404 });
      }
      const [items, payments, tickets] = await Promise.all([
        svc.entities.OrderItem.filter({ order_id: orderId, is_deleted: false }),
        svc.entities.Payment.filter({ order_id: orderId }),
        svc.entities.Ticket.filter({ order_id: orderId, is_deleted: false }),
      ]);
      return Response.json({ order, items, payments, tickets });
    }

    // List caller's orders (most recent first), with items + tickets attached.
    const orders = await svc.entities.Order.filter({ buyer_user_id: user.id });
    const sorted = orders.sort((a: any, b: any) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime());
    const orderIds = sorted.map((o: any) => o.id);

    const eventIds = Array.from(new Set(sorted.map((o: any) => o.event_id).filter(Boolean)));
    const [allItems, allTickets, allPayments, events] = await Promise.all([
      svc.entities.OrderItem.filter({ order_id: { $in: orderIds }, is_deleted: false }),
      svc.entities.Ticket.filter({ order_id: { $in: orderIds }, is_deleted: false }),
      svc.entities.Payment.filter({ order_id: { $in: orderIds } }),
      eventIds.length ? svc.entities.Event.filter({ id: { $in: eventIds } }) : [],
    ]);
    const eventById = new Map(events.map((e: any) => [e.id, e]));

    const result = sorted.map((o: any) => ({
      ...o,
      event: eventById.get(o.event_id) || null,
      items: allItems.filter((i: any) => i.order_id === o.id),
      tickets: allTickets.filter((t: any) => t.order_id === o.id),
      payment: allPayments.find((p: any) => p.order_id === o.id),
    }));

    return Response.json({ orders: result });
  } catch (error: any) {
    console.error('[getMyOrders]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
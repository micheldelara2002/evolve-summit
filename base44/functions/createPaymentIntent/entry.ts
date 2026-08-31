import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveCallerPerson } from "../../shared/sessionAuth.ts";
import { calculateCart, toCents } from "../../shared/commercePolicy.ts";
import { createPaymentIntent } from "../../shared/stripeClient.ts";

// Creates an Order + OrderItems + Stripe PaymentIntent for a cart of tickets.
// Reserves lot quantities atomically (cannot oversell). Returns the client secret
// for in-app Stripe Elements (Pix + card, no redirect).
//
// Payload:
//   eventId, items: [{ lot_id, ticket_type_id, holder_name, holder_email }], couponCode?
//
// Transaction safety:
//   - Lot reservation uses conditional updateMany with a $lte guard on quantity_reserved.
//     If the guard fails (someone else grabbed the last tickets), the order is aborted
//     and any reservations already made are rolled back.
//   - Idempotency: an idempotent Order is created per intent; duplicate calls create
//     separate orders (no double-charge because each has its own PaymentIntent).
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const body = await req.json();
    const { eventId, items, couponCode } = body;
    if (!eventId || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'Carrinho vazio.' }, { status: 400 });
    }

    // Validate items have required fields.
    for (const it of items) {
      if (!it.lot_id || !it.holder_name || !it.holder_email || !it.holder_phone) {
        return Response.json({ error: 'Cada ingresso precisa de lote, nome, email e telefone do titular.' }, { status: 400 });
      }
    }

    // Resolve buyer person.
    const buyerPersonId = await resolveCallerPerson(svc, user);
    const event = (await svc.entities.Event.filter({ id: eventId, is_deleted: false }))[0];
    if (!event) return Response.json({ error: 'Evento não encontrado.' }, { status: 404 });
    // Tickets só são vendidos se o evento estiver ativo (não draft, não finalizado, não cancelado).
    if (event.status !== 'active') {
      return Response.json({ error: 'Ingressos não estão à venda para este evento.' }, { status: 400 });
    }

    const now = new Date();

    // Fetch all lots + ticket types referenced.
    const lotIds = [...new Set(items.map((i: any) => i.lot_id))];
    const lots = await svc.entities.SalesLot.filter({ id: { $in: lotIds }, event_id: eventId, is_deleted: false });
    const lotById: Record<string, any> = {};
    for (const l of lots) lotById[l.id] = l;

    // Validate lots are within sale window and available.
    for (const it of items) {
      const lot = lotById[it.lot_id];
      if (!lot || !lot.is_active) return Response.json({ error: 'Lote indisponível.' }, { status: 400 });
      if (lot.sale_start && new Date(lot.sale_start) > now) return Response.json({ error: `Lote "${lot.name}" ainda não está aberto.` }, { status: 400 });
      if (lot.sale_end && new Date(lot.sale_end) < now) return Response.json({ error: `Lote "${lot.name}" encerrado.` }, { status: 400 });
    }

    // Count per-lot demand for reservation guard.
    const demandByLot: Record<string, number> = {};
    for (const it of items) demandByLot[it.lot_id] = (demandByLot[it.lot_id] || 0) + 1;

    // Check availability first (fast-fail).
    for (const lotId of Object.keys(demandByLot)) {
      const lot = lotById[lotId];
      const remaining = (lot.quantity_total || 0) - (lot.quantity_reserved || 0) - (lot.quantity_sold || 0);
      if (remaining < demandByLot[lotId]) {
        return Response.json({ error: `Lote "${lot.name}" não tem ingressos suficientes (${remaining} disponíveis).` }, { status: 409 });
      }
    }

    // Atomically reserve quantities per lot with a $lte guard.
    const reservedLots: string[] = [];
    for (const lotId of Object.keys(demandByLot)) {
      const lot = lotById[lotId];
      const qty = demandByLot[lotId];
      // Guard: quantity_reserved must stay <= (total - sold - qty) after increment.
      const threshold = (lot.quantity_total || 0) - (lot.quantity_sold || 0) - qty;
      const res = await svc.entities.SalesLot.updateMany(
        { id: lotId, quantity_reserved: { $lte: threshold } },
        { $inc: { quantity_reserved: qty } }
      );
      if (!res || !res.updated) {
        // Race — rollback reservations already made and abort.
        for (const rid of reservedLots) {
          const rq = demandByLot[rid];
          await svc.entities.SalesLot.updateMany({ id: rid }, { $inc: { quantity_reserved: -rq } });
        }
        return Response.json({ error: `Lote "${lot.name}" esgotou enquanto você finalizava. Tente novamente.` }, { status: 409 });
      }
      reservedLots.push(lotId);
    }

    // Build cart lines for total calc.
    const typeIds = [...new Set(items.map((i: any) => i.ticket_type_id || lotById[i.lot_id].ticket_type_id))];
    const ticketTypes = await svc.entities.TicketType.filter({ id: { $in: typeIds }, event_id: eventId, is_deleted: false });
    const typeById: Record<string, any> = {};
    for (const t of ticketTypes) typeById[t.id] = t;

    const lines = items.map((it: any) => {
      const lot = lotById[it.lot_id];
      const typeId = it.ticket_type_id || lot.ticket_type_id;
      const ttype = typeById[typeId];
      return {
        lot_id: it.lot_id,
        ticket_type_id: typeId,
        ticket_type_name: ttype?.name || 'Ingresso',
        unit_price: lot.price,
        holder_name: it.holder_name,
        holder_email: it.holder_email,
        holder_phone: it.holder_phone,
      };
    });

    // Coupon validation.
    let coupon: any = null;
    if (couponCode) {
      const coupons = await svc.entities.Coupon.filter({ event_id: eventId, code: String(couponCode).toUpperCase().trim(), is_deleted: false });
      coupon = coupons[0] || null;
    }
    const totals = calculateCart(lines, coupon, now);
    if (couponCode && !totals.coupon_valid) {
      // release reservations
      for (const lotId of reservedLots) {
        await svc.entities.SalesLot.updateMany({ id: lotId }, { $inc: { quantity_reserved: -demandByLot[lotId] } });
      }
      return Response.json({ error: totals.coupon_message || 'Cupom inválido.' }, { status: 400 });
    }

    // Create Order.
    const order = await svc.entities.Order.create({
      buyer_user_id: user.id,
      buyer_person_id: buyerPersonId || '',
      buyer_name: user.full_name || '',
      buyer_email: user.email || '',
      event_id: eventId,
      status: 'pending',
      subtotal: totals.subtotal,
      discount: totals.discount,
      total: totals.total,
      coupon_id: coupon?.id || '',
      coupon_code: coupon?.code || '',
      currency: 'BRL',
      reserved_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min to pay
      fulfillment_status: 'pending',
    });

    // Create OrderItems.
    const orderItems = [];
    for (const l of lines) {
      const oi = await svc.entities.OrderItem.create({
        order_id: order.id,
        event_id: eventId,
        lot_id: l.lot_id,
        ticket_type_id: l.ticket_type_id,
        ticket_type_name: l.ticket_type_name,
        holder_name: l.holder_name,
        holder_email: l.holder_email,
        holder_phone: l.holder_phone,
        unit_price: l.unit_price,
      });
      orderItems.push(oi);
    }

    // Create Stripe PaymentIntent.
    const amountCents = toCents(totals.total);
    let intent;
    try {
      intent = await createPaymentIntent({
        amountCents,
        currency: 'BRL',
        orderId: order.id,
        eventId,
      });
    } catch (err: any) {
      // Rollback: release reservations + cancel order.
      for (const lotId of reservedLots) {
        await svc.entities.SalesLot.updateMany({ id: lotId }, { $inc: { quantity_reserved: -demandByLot[lotId] } });
      }
      await svc.entities.Order.update(order.id, { status: 'cancelled', error_reason: err?.message });
      console.error('[createPaymentIntent] Stripe error:', err?.message || err);
      return Response.json({ error: `Falha ao iniciar pagamento: ${err?.message || 'erro Stripe'}` }, { status: 502 });
    }

    // Create Payment record.
    const payment = await svc.entities.Payment.create({
      order_id: order.id,
      event_id: eventId,
      buyer_user_id: user.id,
      intent_id: intent.id,
      amount: totals.total,
      amount_cents: amountCents,
      currency: 'BRL',
      status: 'pending',
      provider: 'stripe',
      client_secret: intent.client_secret,
      refunded_amount: 0,
      fulfillment_status: 'pending',
    });

    // Increment coupon uses (atomic, conditional guard).
    if (coupon && totals.coupon_valid) {
      try {
        await svc.entities.Coupon.updateMany(
          { id: coupon.id, uses_count: { $lt: coupon.max_uses || Number.MAX_SAFE_INTEGER } },
          { $inc: { uses_count: 1 } }
        );
      } catch {}
    }

    return Response.json({
      client_secret: intent.client_secret,
      order_id: order.id,
      payment_id: payment.id,
      total: totals.total,
      subtotal: totals.subtotal,
      discount: totals.discount,
    });
  } catch (error: any) {
    console.error('[createPaymentIntent]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from "base44:runtime";
import { constructStripeEvent } from "../../shared/stripeClient.ts";
import { fulfillOrder, releaseReservations, processRefundSuccess } from "../../shared/commerceFulfillment.ts";
import { deliverTickets } from "../../shared/ticketPdf.ts";

// Stripe webhook receiver — validates signature, then handles:
//   payment_intent.succeeded  → idempotent fulfillment (participants + tickets + email)
//   payment_intent.payment_failed → release reservations, mark failed
//   charge.refunded            → cancel participants + tickets (full or partial)
//
// Auth: webhook is unauthenticated (Stripe calls it); authenticity validated via
// HMAC signature with STRIPE_WEBHOOK_SECRET. Service role is used for all DB writes.

export default async function(req: Request): Promise<Response> {
  try {
    const signature = req.headers.get("stripe-signature") || "";
    const bodyText = await req.text();
    const secret = secrets.get("STRIPE_WEBHOOK_SECRET");
    if (!secret) return Response.json({ error: "webhook secret not configured" }, { status: 500 });

    let event;
    try {
      event = await constructStripeEvent(bodyText, signature, secret);
    } catch (err: any) {
      console.error('[stripeWebhook] signature invalid:', err?.message || err);
      return Response.json({ error: "Invalid signature" }, { status: 400 });
    }

    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;
    const evt = event;

    if (evt.type === "payment_intent.succeeded") {
      const pi = evt.data.object;
      const orderId = pi.metadata?.order_id;
      if (!orderId) return Response.json({ received: true, skipped: "no order_id" });

      const order = (await svc.entities.Order.filter({ id: orderId }))[0];
      if (!order) return Response.json({ received: true, skipped: "order not found" });

      const payments = await svc.entities.Payment.filter({ intent_id: pi.id });
      const payment = payments[0];
      if (!payment) return Response.json({ received: true, skipped: "payment not found" });

      const orderItems = await svc.entities.OrderItem.filter({ order_id: orderId, is_deleted: false });
      // Idempotent fulfillment.
      const result = await fulfillOrder(svc, payment, order, orderItems);

      // Best-effort PDF delivery (ingresso com QR) — idempotente (pula já entregues).
      try {
        const event = (await svc.entities.Event.filter({ id: order.event_id }))[0];
        await deliverTickets(svc, event, order, result.tickets, orderItems);
      } catch (delivErr: any) {
        console.error('[stripeWebhook] ticket delivery failed:', delivErr?.message || delivErr);
      }

      return Response.json({ received: true, fulfilled: result.fulfilled, tickets: result.tickets.length });
    }

    if (evt.type === "payment_intent.payment_failed") {
      const pi = evt.data.object;
      const payments = await svc.entities.Payment.filter({ intent_id: pi.id });
      const payment = payments[0];
      if (payment) {
        await svc.entities.Payment.update(payment.id, { status: "failed", error_reason: pi.last_payment_error?.message || "payment failed" });
        const orderItems = await svc.entities.OrderItem.filter({ order_id: payment.order_id, is_deleted: false });
        await releaseReservations(svc, orderItems);
        await svc.entities.Order.update(payment.order_id, { status: "cancelled" });
      }
      return Response.json({ received: true });
    }

    if (evt.type === "charge.refunded") {
      const charge = evt.data.object;
      const piId = charge.payment_intent;
      const payments = await svc.entities.Payment.filter({ intent_id: piId });
      const payment = payments[0];
      if (!payment) return Response.json({ received: true, skipped: "payment not found" });
      const order = (await svc.entities.Order.filter({ id: payment.order_id }))[0];
      if (!order) return Response.json({ received: true, skipped: "order not found" });

      const refundAmountBRL = (charge.amount_refunded || 0) / 100;
      const isPartial = (charge.amount_refunded || 0) < (charge.amount || 0);
      // Per-item: se houver RefundRequest cancel_item, cancela só esses itens.
      let orderItemIds: string[] | undefined = undefined;
      try {
        const reqs = await svc.entities.RefundRequest.filter({ payment_id: payment.id });
        const latest = reqs.sort((a: any, b: any) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime())[0];
        if (latest && latest.refund_type === "cancel_item" && Array.isArray(latest.order_item_ids) && latest.order_item_ids.length > 0) {
          orderItemIds = latest.order_item_ids;
        }
      } catch {}
      await processRefundSuccess(svc, payment, order, refundAmountBRL, isPartial, orderItemIds);
      return Response.json({ received: true, refundAmount: refundAmountBRL, partial: isPartial });
    }

    // Unhandled event type — acknowledge so Stripe stops retrying.
    return Response.json({ received: true, skipped: evt.type });
  } catch (error: any) {
    console.error('[stripeWebhook] error:', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
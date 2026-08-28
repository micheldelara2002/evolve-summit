import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { retrievePaymentIntent } from "../../shared/stripeClient.ts";
import { fulfillOrder, releaseReservations } from "../../shared/commerceFulfillment.ts";

// Polling fallback for payment status — used when the client (Pix flow) doesn't
// receive the webhook in time, or to confirm after Stripe Elements confirms.
// Idempotent: if already fulfilled, returns success; if newly succeeded, fulfills.
//
// Payload: paymentId

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const { paymentId } = body;
    if (!paymentId) return Response.json({ error: 'paymentId obrigatório.' }, { status: 400 });

    const svc = base44.asServiceRole;
    const payments = await svc.entities.Payment.filter({ id: paymentId, buyer_user_id: user.id });
    const payment = payments[0];
    if (!payment) return Response.json({ error: 'Pagamento não encontrado.' }, { status: 404 });

    // Already terminal?
    if (payment.status === "succeeded" && payment.fulfillment_status === "fulfilled") {
      return Response.json({ status: "succeeded", fulfillment_status: "fulfilled" });
    }
    if (payment.status === "failed" || payment.status === "expired") {
      return Response.json({ status: payment.status });
    }

    // Ask Stripe for the live status.
    let intent;
    try {
      intent = await retrievePaymentIntent(payment.intent_id);
    } catch (err: any) {
      return Response.json({ error: `Falha ao consultar Stripe: ${err?.message || err}` }, { status: 502 });
    }

    const piStatus = intent.status;

    if (piStatus === "succeeded") {
      const order = (await svc.entities.Order.filter({ id: payment.order_id }))[0];
      const orderItems = await svc.entities.OrderItem.filter({ order_id: payment.order_id, is_deleted: false });
      const result = await fulfillOrder(svc, payment, order, orderItems);
      return Response.json({ status: "succeeded", fulfillment_status: result.fulfilled ? "fulfilled" : "pending_retry", tickets: result.tickets.length, error: result.error });
    }

    if (piStatus === "canceled") {
      const orderItems = await svc.entities.OrderItem.filter({ order_id: payment.order_id, is_deleted: false });
      await releaseReservations(svc, orderItems);
      await svc.entities.Payment.update(paymentId, { status: "expired" });
      await svc.entities.Order.update(payment.order_id, { status: "cancelled" });
      return Response.json({ status: "expired" });
    }

    if (piStatus === "requires_payment_method" || piStatus === "requires_action") {
      return Response.json({ status: "pending", pi_status: piStatus });
    }

    // processing / requires_capture etc.
    return Response.json({ status: "pending", pi_status: piStatus });
  } catch (error: any) {
    console.error('[getPaymentStatus]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
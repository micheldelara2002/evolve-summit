import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveRefundPolicy, evaluateRefund, toCents, DEFAULT_GLOBAL_REFUND_POLICY } from "../../shared/commercePolicy.ts";
import { createRefund } from "../../shared/stripeClient.ts";
import { processRefundSuccess } from "../../shared/commerceFulfillment.ts";

// Request a refund for an order. Evaluates the effective refund policy (global +
// per-event override) and calls Stripe refund API. On success, cancels participants
// and tickets (idempotent via processRefundSuccess).
//
// Payload:
//   paymentId, reason?, refundType? ('full' | 'partial'), manualApprove? (admin-only)
//
// Authorization: the buyer (own order) OR admin. Admin can pass manualApprove=true
// to override the policy window (if allow_manual_override).

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;
    const isAdmin = user.role === "admin";

    const body = await req.json();
    const { paymentId, reason, refundType = "full", manualApprove = false } = body;
    if (!paymentId) return Response.json({ error: "paymentId obrigatório." }, { status: 400 });

    const payments = await svc.entities.Payment.filter({ id: paymentId });
    const payment = payments[0];
    if (!payment) return Response.json({ error: "Pagamento não encontrado." }, { status: 404 });

    // Authorization: buyer or admin.
    if (payment.buyer_user_id !== user.id && !isAdmin) {
      return Response.json({ error: "Sem permissão." }, { status: 403 });
    }

    if (payment.status !== "succeeded") {
      return Response.json({ error: "Este pagamento não pode ser estornado (status atual: " + payment.status + ")." }, { status: 400 });
    }

    const order = (await svc.entities.Order.filter({ id: payment.order_id }))[0];
    if (!order) return Response.json({ error: "Pedido não encontrado." }, { status: 404 });

    const event = (await svc.entities.Event.filter({ id: order.event_id }))[0];

    // Evaluate policy.
    let override: any = null;
    try { override = event?.refund_policy ? JSON.parse(event.refund_policy) : null; } catch {}
    const policy = resolveRefundPolicy(override, { refund_policy: DEFAULT_GLOBAL_REFUND_POLICY });
    const isManual = isAdmin && manualApprove;
    const evalResult = evaluateRefund(policy, event?.start_date, new Date(), payment.amount, isManual);

    if (!evalResult.allowed) {
      return Response.json({ error: evalResult.reason, decision: evalResult.decision }, { status: 403 });
    }

    const refundAmountBRL = refundType === "partial" ? evalResult.refundableAmount : payment.amount;
    const isPartial = refundType === "partial" || refundAmountBRL < payment.amount;
    const refundAmountCents = toCents(refundAmountBRL);

    // Call Stripe refund (idempotent by payment_id).
    let refund;
    try {
      refund = await createRefund({
        paymentIntentId: payment.intent_id,
        amountCents: isPartial ? refundAmountCents : undefined,
        reason: reason || "requested_by_customer",
        idempotencyKey: `refund_${payment.id}_${refundType}`,
      });
    } catch (err: any) {
      console.error('[requestRefund] Stripe refund failed:', err?.message || err);
      return Response.json({ error: `Falha no estorno: ${err?.message || err}` }, { status: 502 });
    }

    if (refund.status === "failed") {
      return Response.json({ error: "Estorno falhou no Stripe.", refund_status: refund.status }, { status: 502 });
    }

    // Record the refund request.
    await svc.entities.RefundRequest.create({
      order_id: order.id,
      payment_id: payment.id,
      event_id: order.event_id,
      requested_by_user_id: user.id,
      requested_by_name: user.full_name || "",
      reason: reason || "",
      refund_type: refundType,
      amount_requested: refundAmountBRL,
      amount_refunded: refundAmountBRL,
      policy_decision: evalResult.decision,
      status: refund.status === "succeeded" ? "processed" : "pending",
      processed_at: refund.status === "succeeded" ? new Date().toISOString() : "",
    });

    // If the refund succeeded immediately (most card refunds), process locally now.
    // Pix refunds are typically async (pending → succeeded later via charge.refund.updated webhook).
    if (refund.status === "succeeded") {
      await processRefundSuccess(svc, payment, order, refundAmountBRL, isPartial);
    }

    return Response.json({
      ok: true,
      refund_status: refund.status,
      refund_amount: refundAmountBRL,
      partial: isPartial,
      decision: evalResult.decision,
      reason: evalResult.reason,
    });
  } catch (error: any) {
    console.error('[requestRefund]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
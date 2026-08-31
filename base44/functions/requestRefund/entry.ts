import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveRefundPolicy, evaluateRefund, toCents, DEFAULT_GLOBAL_REFUND_POLICY } from "../../shared/commercePolicy.ts";
import { createRefund } from "../../shared/stripeClient.ts";
import { processRefundSuccess } from "../../shared/commerceFulfillment.ts";

// Request a refund for an order. Supports:
//   - full: estorna o pedido inteiro (100%) e cancela todos ingressos/participantes.
//   - partial: estorno parcial por valor (percentual da política).
//   - cancel_item: estorna ingresso(s) específico(s) — partial refund no Stripe do
//     valor dos itens selecionados, cancela apenas o ticket/participante daqueles itens.
//
// Evaluates the effective refund policy (global + per-event override). Admin can
// pass manualApprove=true to override the policy window.
//
// Payload:
//   paymentId, reason?, refundType? ('full' | 'partial' | 'cancel_item'),
//   manualApprove? (admin-only), order_item_ids?: string[] (cancel_item)

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;
    const isAdmin = user.role === "admin";

    const body = await req.json();
    const { paymentId, reason, refundType = "full", manualApprove = false, order_item_ids = [] } = body;
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

    // ===== cancel_item: per-ticket refund =====
    if (refundType === "cancel_item") {
      if (!Array.isArray(order_item_ids) || order_item_ids.length === 0) {
        return Response.json({ error: "Selecione ao menos um ingresso para estornar." }, { status: 400 });
      }
      const allItems = await svc.entities.OrderItem.filter({ order_id: order.id, is_deleted: false });
      const itemSet = new Set(order_item_ids);
      const selected = allItems.filter((i: any) => itemSet.has(i.id));
      if (selected.length === 0) return Response.json({ error: "Ingresso(s) não encontrado(s) no pedido." }, { status: 400 });
      const refundable = selected.filter((i: any) => !i.refunded);
      if (refundable.length === 0) return Response.json({ error: "Os ingressos selecionados já foram estornados." }, { status: 400 });
      const itemSum = refundable.reduce((s: number, i: any) => s + (Number(i.unit_price) || 0), 0);

      const evalResult = evaluateRefund(policy, event?.start_date, new Date(), itemSum, isManual);
      if (!evalResult.allowed) {
        return Response.json({ error: evalResult.reason, decision: evalResult.decision }, { status: 403 });
      }
      const refundAmountBRL = evalResult.refundableAmount;
      const refundAmountCents = toCents(refundAmountBRL);
      const itemIds = refundable.map((i: any) => i.id);
      const idemKey = `refund_${payment.id}_item_${itemIds.sort().join("_")}`;

      let refund;
      try {
        refund = await createRefund({
          paymentIntentId: payment.intent_id,
          amountCents: refundAmountCents,
          reason: reason || "requested_by_customer",
          idempotencyKey: idemKey,
        });
      } catch (err: any) {
        console.error('[requestRefund] cancel_item Stripe failed:', err?.message || err);
        return Response.json({ error: `Falha no estorno: ${err?.message || err}` }, { status: 502 });
      }
      if (refund.status === "failed") {
        return Response.json({ error: "Estorno falhou no Stripe.", refund_status: refund.status }, { status: 502 });
      }

      await svc.entities.RefundRequest.create({
        order_id: order.id,
        payment_id: payment.id,
        event_id: order.event_id,
        requested_by_user_id: user.id,
        requested_by_name: user.full_name || "",
        reason: reason || "",
        refund_type: "cancel_item",
        amount_requested: refundAmountBRL,
        amount_refunded: refundAmountBRL,
        policy_decision: evalResult.decision,
        status: refund.status === "succeeded" ? "processed" : "pending",
        processed_at: refund.status === "succeeded" ? new Date().toISOString() : "",
        order_item_ids: itemIds,
      });

      if (refund.status === "succeeded") {
        await processRefundSuccess(svc, payment, order, refundAmountBRL, true, itemIds);
      }

      return Response.json({
        ok: true,
        refund_status: refund.status,
        refund_amount: refundAmountBRL,
        partial: true,
        cancelled_items: itemIds.length,
        decision: evalResult.decision,
        reason: evalResult.reason,
      });
    }

    // ===== full / partial =====
    const evalResult = evaluateRefund(policy, event?.start_date, new Date(), payment.amount, isManual);
    if (!evalResult.allowed) {
      return Response.json({ error: evalResult.reason, decision: evalResult.decision }, { status: 403 });
    }

    const refundAmountBRL = refundType === "partial" ? evalResult.refundableAmount : payment.amount;
    const isPartial = refundType === "partial" || refundAmountBRL < payment.amount;
    const refundAmountCents = toCents(refundAmountBRL);

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
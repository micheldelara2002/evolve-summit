import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { resolveRefundPolicy, evaluateRefund, toCents, DEFAULT_GLOBAL_REFUND_POLICY } from "../../shared/commercePolicy.ts";
import { createRefund } from "../../shared/stripeClient.ts";
import { processRefundSuccess } from "../../shared/commerceFulfillment.ts";
import { sendTransactionalEmail } from "../../shared/transactionalEmail.ts";

// Solicita um estorno/cancelamento de pedido. Suporta:
//   - full: estorna o pedido inteiro (100%).
//   - partial: estorno parcial por valor (percentual da política).
//   - cancel_item: estorna ingresso(s) específico(s) — valor LÍQUIDO por item,
//     com rateio proporcional do cupom do pedido (nunca estorna acima do pago).
//
// PEDIDOS PAGOS: valida autorização + política, grava a RefundRequest e dispara o
// refund no Stripe — mas NÃO grava refunded_amount nem altera ingressos/participantes.
// O webhook charge.refunded é a única fonte que processa o estorno (valor
// autoritativo: charge.amount_refunded do Stripe). Chamadas repetidas (requisição,
// webhook, retries) sempre convergem para o mesmo resultado.
//
// PEDIDOS 100% GRATUITOS (cupom integral, sem cobrança no Stripe): cancelamento
// local de ingressos/participantes + e-mail para comprador/titulares afetados.
//
// Payload:
//   paymentId, reason?, refundType? ('full' | 'partial' | 'cancel_item'),
//   manualApprove? (admin-only), order_item_ids?: string[] (cancel_item)

const round2 = (v: number) => Math.round(v * 100) / 100;

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

    // Authorization: buyer, admin, or event manager/team (gestão do evento).
    if (payment.buyer_user_id !== user.id && !isAdmin) {
      const mgrAuth = await verifyEventMembership(base44, user, payment.event_id, EVENT_MANAGER_ROLES);
      if (!mgrAuth.authorized) {
        return Response.json({ error: "Sem permissão." }, { status: 403 });
      }
    }

    if (payment.status !== "succeeded") {
      return Response.json({ error: "Este pagamento não pode ser estornado (status atual: " + payment.status + ")." }, { status: 400 });
    }

    const order = (await svc.entities.Order.filter({ id: payment.order_id }))[0];
    if (!order) return Response.json({ error: "Pedido não encontrado." }, { status: 404 });

    const event = (await svc.entities.Event.filter({ id: order.event_id }))[0];

    // Evaluate policy (global + per-event override).
    let override: any = null;
    try { override = event?.refund_policy ? JSON.parse(event.refund_policy) : null; } catch {}
    const policy = resolveRefundPolicy(override, { refund_policy: DEFAULT_GLOBAL_REFUND_POLICY });
    const isManual = isAdmin && manualApprove;

    // ===== cancel_item: seleção + rateio proporcional do cupom =====
    // Valor líquido por item = unit_price − desconto do pedido rateado
    // proporcionalmente ao subtotal. Sem isso, o estorno por item soma valores
    // brutos e devolve mais do que foi pago quando há cupom no pedido.
    let itemIds: string[] | undefined;
    let itemLiquidBRL = 0;
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
      const subtotal = round2(allItems.reduce((s: number, i: any) => s + (Number(i.unit_price) || 0), 0));
      const discount = Math.max(0, Number(order.discount) || 0);
      let liquid = 0;
      for (const it of refundable) {
        const price = Number(it.unit_price) || 0;
        const share = subtotal > 0 ? (price / subtotal) * discount : 0;
        liquid += Math.max(0, price - share);
      }
      itemLiquidBRL = round2(liquid);
      itemIds = refundable.map((i: any) => i.id);
    }

    // ===== Pedidos 100% gratuitos: cancelamento local + e-mail (sem Stripe) =====
    const isFree = payment.provider === "free" ||
      String(payment.intent_id || "").startsWith("free_") ||
      (Number(payment.amount_cents) || 0) <= 0;
    if (isFree) {
      const evalFree = evaluateRefund(policy, event?.start_date, new Date(), 0, isManual);
      if (!evalFree.allowed) {
        return Response.json({ error: evalFree.reason, decision: evalFree.decision }, { status: 403 });
      }

      const refundRequest = await svc.entities.RefundRequest.create({
        order_id: order.id,
        payment_id: payment.id,
        event_id: order.event_id,
        requested_by_user_id: user.id,
        requested_by_name: user.full_name || "",
        reason: reason || "",
        refund_type: refundType,
        amount_requested: 0,
        amount_refunded: 0,
        policy_decision: evalFree.decision,
        status: "processed",
        processed_at: new Date().toISOString(),
        order_item_ids: itemIds || [],
      });

      // Cancelamento local idempotente (ingressos/participantes/pedido).
      await processRefundSuccess(svc, payment, order, 0, refundType === "cancel_item", itemIds);

      // E-mail para comprador + titulares afetados.
      try {
        const tickets = await svc.entities.Ticket.filter({ order_id: order.id, is_deleted: false });
        const affected = itemIds ? tickets.filter((t: any) => itemIds.includes(t.order_item_id)) : tickets;
        const emails = new Set<string>();
        if (order.buyer_email) emails.add(order.buyer_email);
        for (const t of affected) if (t.holder_email) emails.add(t.holder_email);
        for (const to of emails) {
          try {
            // Idempotente por marcador: chamadas repetidas não reenviam.
            await sendTransactionalEmail(svc, {
              dedupeKey: `free_cancel:${refundRequest.id}:${to}`,
              to,
              subject: `Cancelamento de ingresso — ${event?.name || "Evento"}`,
              body:
                `Olá!\n\nO ingresso gratuito do pedido de "${event?.name || "Evento"}" foi cancelado` +
                `${reason ? ` (motivo: ${reason})` : ""}.\n` +
                `Se isso foi um engano, fale com a organização do evento.\n\nEvolve Summit`,
            });
          } catch (emailErr: any) {
            console.error('[requestRefund] free cancel email failed:', emailErr?.message || emailErr);
          }
        }
      } catch (tErr: any) {
        console.error('[requestRefund] free cancel tickets load failed:', tErr?.message || tErr);
      }

      return Response.json({
        ok: true,
        free: true,
        refund_status: "processed",
        cancelled_items: itemIds?.length || 0,
        decision: evalFree.decision,
        reason: "Ingresso gratuito cancelado.",
      });
    }

    // ===== Pedidos pagos: dispara o estorno no Stripe (processamento só no webhook) =====
    const evalAmount = refundType === "cancel_item" ? itemLiquidBRL : payment.amount;
    const evalResult = evaluateRefund(policy, event?.start_date, new Date(), evalAmount, isManual);
    if (!evalResult.allowed) {
      return Response.json({ error: evalResult.reason, decision: evalResult.decision }, { status: 403 });
    }

    const refundAmountBRL = (refundType === "partial" || refundType === "cancel_item")
      ? evalResult.refundableAmount
      : payment.amount;
    const isPartial = refundType === "partial" || refundAmountBRL < payment.amount;

    // Teto: nunca estorna acima do que foi pago e ainda não devolvido.
    const paidCents = Number(payment.amount_cents) || toCents(payment.amount);
    const refundedCents = toCents(Number(payment.refunded_amount) || 0);
    const remainingCents = Math.max(0, paidCents - refundedCents);
    const refundAmountCents = Math.min(toCents(refundAmountBRL), remainingCents);
    if (refundAmountCents <= 0) {
      return Response.json({ error: "Não há valor a estornar para este pagamento." }, { status: 400 });
    }

    // RefundRequest ANTES do Stripe: o webhook charge.refunded procura a
    // solicitação correspondente (cancel_item usa order_item_ids) — ela precisa
    // existir quando o webhook chegar.
    const idemKey = refundType === "cancel_item"
      ? `refund_${payment.id}_item_${[...(itemIds || [])].sort().join("_")}`
      : `refund_${payment.id}_${refundType}`;
    const refundRequest = await svc.entities.RefundRequest.create({
      order_id: order.id,
      payment_id: payment.id,
      event_id: order.event_id,
      requested_by_user_id: user.id,
      requested_by_name: user.full_name || "",
      reason: reason || "",
      refund_type: refundType,
      amount_requested: refundAmountCents / 100,
      amount_refunded: 0,
      policy_decision: evalResult.decision,
      status: "pending",
      order_item_ids: itemIds || [],
    });

    let refund;
    try {
      refund = await createRefund({
        paymentIntentId: payment.intent_id,
        amountCents: isPartial ? refundAmountCents : undefined,
        reason: reason || "requested_by_customer",
        idempotencyKey: idemKey,
        reverseTransfer: !!payment.destination_account_id,
        refundApplicationFee: !!payment.destination_account_id,
      });
    } catch (err: any) {
      try { await svc.entities.RefundRequest.update(refundRequest.id, { status: "failed", rejection_reason: err?.message || String(err) }); } catch {}
      console.error('[requestRefund] Stripe refund failed:', err?.message || err);
      return Response.json({ error: `Falha no estorno: ${err?.message || err}` }, { status: 502 });
    }

    if (refund.status === "failed") {
      try { await svc.entities.RefundRequest.update(refundRequest.id, { status: "failed" }); } catch {}
      return Response.json({ error: "Estorno falhou no Stripe.", refund_status: refund.status }, { status: 502 });
    }

    // Refund criado no Stripe — a confirmação (ingressos, participantes,
    // refunded_amount, status do pedido) acontece quando o webhook
    // charge.refunded chegar. Nada de estado financeiro é gravado aqui.
    return Response.json({
      ok: true,
      refund_status: refund.status, // status do objeto refund no Stripe (não do pedido)
      pending_confirmation: true,
      refund_amount: refundAmountCents / 100,
      partial: isPartial,
      cancelled_items: itemIds?.length || 0,
      decision: evalResult.decision,
      reason: evalResult.reason,
    });
  } catch (error: any) {
    console.error('[requestRefund]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
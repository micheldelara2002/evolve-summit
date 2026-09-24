import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from "base44:runtime";
import { constructStripeEvent, retrieveChargeWithRefunds } from "../../shared/stripeClient.ts";
import { fulfillOrder, releaseReservations, processRefundSuccess, captureStripeFee } from "../../shared/commerceFulfillment.ts";
import { deliverTickets } from "../../shared/ticketPdf.ts";

// Stripe webhook receiver — validates signature, then handles:
//   payment_intent.succeeded  → idempotent fulfillment (participants + tickets + email)
//   payment_intent.payment_failed → registra o erro; pedido/reservas seguem de pé
//                                  (o cliente pode tentar pagar de novo — sem oversell)
//   payment_intent.canceled  → libera reservas, marca pagamento expirado + pedido cancelado
//   charge.refunded          → ÚNICO gravador de refunded_amount (valor autoritativo
//                              do Stripe); cancela ingressos/participantes + confirma a RefundRequest
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

      const payments = await svc.entities.Payment.filter({ intent_id: pi.id }, "-created_date", 1);
      const payment = payments[0];
      if (!payment) return Response.json({ received: true, skipped: "payment not found" });

      const orderItems = await svc.entities.OrderItem.filter({ order_id: orderId, is_deleted: false });

      // Captura a taxa do Stripe desta venda (balance_transaction do charge) —
      // best-effort, nunca bloqueia o fulfillment; gravação idempotente (só
      // preenche se ainda não foi). Usada no cálculo do líquido do organizador.
      await captureStripeFee(svc, payment, pi.latest_charge);

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
      // Cartão recusado NÃO cancela o pedido nem libera reservas: o cliente
      // continua na tela de pagamento e pode tentar de novo com o MESMO pedido.
      // Cancelar aqui liberaria o lugar para outro comprador e causaria oversell
      // se a tentativa seguinte passasse. Cancelamento/liberação só ocorrem quando
      // o PaymentIntent chega a 'canceled' (abaixo ou polling de status).
      const pi = evt.data.object;
      const payments = await svc.entities.Payment.filter({ intent_id: pi.id }, "-created_date", 1);
      const payment = payments[0];
      if (payment && payment.status === "pending") {
        await svc.entities.Payment.update(payment.id, {
          error_reason: pi.last_payment_error?.message || "payment failed",
        });
      }
      return Response.json({ received: true });
    }

    if (evt.type === "payment_intent.canceled") {
      // Intent cancelado (abandono, expiry futura, checkout reaberto): aqui sim
      // libera as reservas e encerra o pedido.
      const pi = evt.data.object;
      const payments = await svc.entities.Payment.filter({ intent_id: pi.id }, "-created_date", 1);
      const payment = payments[0];
      if (payment && payment.status !== "succeeded") {
        await svc.entities.Payment.update(payment.id, { status: "expired" });
        // Só encerra o pedido se NÃO houver outra transação viva (pending ou
        // succeeded) nele — ex.: checkout reaberto criou um novo PaymentIntent
        // sobre o MESMO pedido; derrubar o pedido aqui cancelaria uma compra em
        // andamento (corrida de webhooks). Reservas seguem presas enquanto o
        // novo intent estiver aberto.
        const siblings = await svc.entities.Payment.filter({ order_id: payment.order_id, is_deleted: false });
        // Regra de 'pagamento vivo' (igual ao job de expiração): pending OU
        // succeeded OU em fulfillment (pending_retry/fulfilled).
        const hasLiveSibling = siblings.some((p: any) => p.id !== payment.id && (
          p.status === "pending" || p.status === "succeeded" ||
          p.fulfillment_status === "pending_retry" || p.fulfillment_status === "fulfilled"
        ));
        if (!hasLiveSibling) {
          const orderItems = await svc.entities.OrderItem.filter({ order_id: payment.order_id, is_deleted: false });
          await releaseReservations(svc, orderItems);
          await svc.entities.Order.update(payment.order_id, { status: "cancelled" });
        }
      }
      return Response.json({ received: true });
    }

    if (evt.type === "charge.refunded") {
      const charge = evt.data.object;
      const piId = charge.payment_intent;
      const payments = await svc.entities.Payment.filter({ intent_id: piId }, "-created_date", 1);
      const payment = payments[0];
      if (!payment) return Response.json({ received: true, skipped: "payment not found" });
      const order = (await svc.entities.Order.filter({ id: payment.order_id }))[0];
      if (!order) return Response.json({ received: true, skipped: "order not found" });

      const refundAmountBRL = (charge.amount_refunded || 0) / 100;
      const isPartial = (charge.amount_refunded || 0) < (charge.amount || 0);

      // Associa o estorno à solicitação PELO ID do Refund do Stripe (não por
      // ordenação temporal): estornos por item concorrentes cancelam os itens
      // certos. IDs do evento vêm em charge.refunds.data; se ausentes, recupera
      // o charge na API. Fallback legado: solicitação mais recente.
      let refundIds: string[] = ((charge.refunds && charge.refunds.data) || []).map((r: any) => r.id);
      if (refundIds.length === 0) {
        try {
          const fullCharge = await retrieveChargeWithRefunds(charge.id);
          refundIds = ((fullCharge.refunds && fullCharge.refunds.data) || []).map((r: any) => r.id);
        } catch (expErr: any) {
          console.error('[stripeWebhook] charge refunds lookup failed:', expErr?.message || expErr);
        }
      }
      const reqs = await svc.entities.RefundRequest.filter({ payment_id: payment.id, is_deleted: false });
      let matched = reqs.find((r: any) => r.stripe_refund_id && refundIds.includes(r.stripe_refund_id));
      if (!matched) {
        matched = reqs.sort((a: any, b: any) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime())[0];
      }
      // Per-item: se a solicitação casada for cancel_item, cancela só esses itens.
      const orderItemIds = matched && matched.refund_type === "cancel_item"
        && Array.isArray(matched.order_item_ids) && matched.order_item_ids.length > 0
        ? matched.order_item_ids
        : undefined;
      const refundOutcome = await processRefundSuccess(svc, payment, order, refundAmountBRL, isPartial, orderItemIds);
      if (refundOutcome.usedSkipped > 0) {
        // Estorno direto no painel do Stripe sobre ingresso já utilizado (P3):
        // o dinheiro voltou (Stripe é autoritativo), mas o ingresso UTILIZADO
        // não é cancelado silenciosamente — alerta o admin (auditoria +
        // solicitação marcada). Reverter o check-in é pré-requisito para tratar.
        try {
          await svc.entities.AuditLog.create({
            action: "status_change",
            entity_type: "Payment",
            entity_id: payment.id,
            details: JSON.stringify({ type: "refund_used_ticket_blocked", used_skipped: refundOutcome.usedSkipped }),
            event_id: order.event_id,
            user_id: order.buyer_user_id,
          });
        } catch (usedErr: any) {
          console.error('[stripeWebhook] used-ticket audit failed:', usedErr?.message || usedErr);
        }
        if (matched) {
          try {
            await svc.entities.RefundRequest.update(matched.id, {
              status: "failed",
              rejection_reason: "Estorno no Stripe atingiu ingresso(s) já utilizado(s) — ingresso mantido válido; reverta o check-in para revisar.",
            });
          } catch {}
        }
      }

      // Confirma a solicitação correspondente (requestRefund apenas dispara o
      // estorno no Stripe — o webhook é quem processa).
      try {
        if (matched && matched.status !== "processed" && matched.status !== "failed") {
          await svc.entities.RefundRequest.update(matched.id, {
            status: "processed",
            processed_at: new Date().toISOString(),
            amount_refunded: matched.amount_requested || refundAmountBRL,
          });
        }
      } catch (reqErr: any) {
        console.error('[stripeWebhook] refund request confirm failed:', reqErr?.message || reqErr);
      }
      return Response.json({ received: true, refundAmount: refundAmountBRL, partial: isPartial });
    }

    // Unhandled event type — acknowledge so Stripe stops retrying.
    return Response.json({ received: true, skipped: evt.type });
  } catch (error: any) {
    console.error('[stripeWebhook] error:', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
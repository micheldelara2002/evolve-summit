import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from "base44:runtime";
import { constructStripeEvent, retrieveChargeWithRefunds } from "../../shared/stripeClient.ts";
import { fulfillOrder, captureStripeFee, expirePaymentOnce, applyConfirmedStripeRefund } from "../../shared/commerceFulfillment.ts";
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
      // Intent cancelado (abandono, expiry futura, checkout reaberto): encerra
      // o pagamento EXATAMENTE UMA VEZ — CAS duplo (pending→expired no Payment,
      // pending→cancelled no Order) dentro de expirePaymentOnce. Entregas
      // duplicadas deste evento NÃO devolvem a mesma reserva duas vezes
      // (anti-oversell); um checkout reaberto (novo PaymentIntent vivo no
      // mesmo pedido) mantém o pedido e as reservas de pé.
      const pi = evt.data.object;
      const payments = await svc.entities.Payment.filter({ intent_id: pi.id }, "-created_date", 1);
      const payment = payments[0];
      if (payment && payment.status === "pending") {
        await expirePaymentOnce(svc, payment);
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
      // Processa o estorno com a lógica comum ao webhook e ao reconciler do
      // job agendado: cancela ingressos/participantes afetados, atribui o
      // valor cumulativo autoritativo, alerta ingresso já utilizado e
      // confirma a solicitação correspondente.
      const outcome = await applyConfirmedStripeRefund(
        svc, payment, order, matched,
        (charge.amount_refunded || 0), (charge.amount || 0)
      );
      return Response.json({ received: true, refundAmount: outcome.refundAmountBRL, partial: outcome.isPartial });
    }

    // Unhandled event type — acknowledge so Stripe stops retrying.
    return Response.json({ received: true, skipped: evt.type });
  } catch (error: any) {
    console.error('[stripeWebhook] error:', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
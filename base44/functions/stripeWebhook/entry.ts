import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { secrets } from "base44:runtime";
import { constructStripeEvent, retrieveChargeWithRefunds } from "../../shared/stripeClient.ts";
import { fulfillOrder, captureStripeFee, expirePaymentOnce, applyConfirmedStripeRefund, applyUnassociatedRefundAmount } from "../../shared/commerceFulfillment.ts";
import { associateRefundsToRequests } from "../../shared/refundGuards.ts";
import { deliverTickets } from "../../shared/ticketPdf.ts";
import { buildAuditKey, recordPendingTrail, writeMandatoryAudit } from "../../shared/auditTrail.ts";

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

      // ===== P0-B — TRILHA OBRIGATÓRIA (pagamento confirmado) =====
      // Efeito externo já ocorreu (o Stripe cobrou): nada é reenviado ao
      // provedor. Sem trilha confirmada NÃO há emissão de ingressos nem
      // resposta de sucesso — o caso fica pendente e rastreável, e o 5xx faz o
      // Stripe reenviar (o fulfillment é idempotente).
      const paidAmountBRL = (Number(pi.amount_received ?? pi.amount) || 0) / 100;
      try {
        await writeMandatoryAudit(svc, {
          action: "status_change",
          entity_type: "Payment",
          entity_id: payment.id,
          user_id: "system",
          user_name: "Stripe",
          event_id: order.event_id,
          audit_key: buildAuditKey("pagamento_confirmado", pi.id),
          provider: "stripe",
          external_reference: pi.id,
          amount: paidAmountBRL,
          details: JSON.stringify({
            type: "pagamento_confirmado",
            order_id: order.id,
            payment_id: payment.id,
            intent_id: pi.id,
            valor_pago: paidAmountBRL,
            valor_pedido: order.total || 0,
            moeda: pi.currency || "brl",
          }),
        });
      } catch (auditErr: any) {
        await recordPendingTrail(svc, {
          action: "status_change",
          entity_type: "Payment",
          entity_id: payment.id,
          event_id: order.event_id,
          audit_key: buildAuditKey("pagamento_confirmado", pi.id),
          provider: "stripe",
          external_reference: pi.id,
          amount: paidAmountBRL,
          failure_reason: auditErr?.message || String(auditErr),
          details: JSON.stringify({ type: "pagamento_confirmado", order_id: order.id, payment_id: payment.id, intent_id: pi.id }),
        });
        console.error("[stripeWebhook] trilha obrigatória indisponível (succeeded):", auditErr?.message || auditErr);
        return Response.json({ error: "auditoria indisponivel" }, { status: 500 });
      }

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
        // P0-B — trilha obrigatória antes de encerrar pagamento e devolver
        // reservas: sem trilha confirmada o encerramento não acontece (o Stripe
        // reenvia o evento; a expiração é idempotente).
        try {
          await writeMandatoryAudit(svc, {
            action: "status_change",
            entity_type: "Payment",
            entity_id: payment.id,
            user_id: "system",
            user_name: "Stripe",
            event_id: payment.event_id,
            audit_key: buildAuditKey("pagamento_cancelado", pi.id),
            provider: "stripe",
            external_reference: pi.id,
            amount: (Number(pi.amount) || 0) / 100,
            details: JSON.stringify({
              type: "pagamento_cancelado",
              order_id: payment.order_id,
              payment_id: payment.id,
              intent_id: pi.id,
            }),
          });
        } catch (auditErr: any) {
          await recordPendingTrail(svc, {
            action: "status_change",
            entity_type: "Payment",
            entity_id: payment.id,
            event_id: payment.event_id,
            audit_key: buildAuditKey("pagamento_cancelado", pi.id),
            provider: "stripe",
            external_reference: pi.id,
            amount: (Number(pi.amount) || 0) / 100,
            failure_reason: auditErr?.message || String(auditErr),
            details: JSON.stringify({ type: "pagamento_cancelado", order_id: payment.order_id, payment_id: payment.id, intent_id: pi.id }),
          });
          console.error("[stripeWebhook] trilha obrigatória indisponível (canceled):", auditErr?.message || auditErr);
          return Response.json({ error: "auditoria indisponivel" }, { status: 500 });
        }
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

      // P0.2 (patch Fase 1) — CORRELAÇÃO SEM FALLBACK TEMPORAL.
      // A solicitação só é reconhecida por IDENTIDADE: `stripe_refund_id` já
      // gravado ou `metadata.refund_request_id` do próprio Refund. A
      // "solicitação mais recente" (corrida webhook × gravação do ID) foi
      // REMOVIDA — ela podia associar o estorno à solicitação errada.
      let refundObjects: any[] = ((charge.refunds && charge.refunds.data) || []).filter((r: any) => r && r.id);
      if (refundObjects.length === 0) {
        try {
          const fullCharge = await retrieveChargeWithRefunds(charge.id);
          refundObjects = ((fullCharge.refunds && fullCharge.refunds.data) || []).filter((r: any) => r && r.id);
        } catch (expErr: any) {
          console.error('[stripeWebhook] charge refunds lookup failed:', expErr?.message || expErr);
        }
      }
      const reqs = await svc.entities.RefundRequest.filter({ payment_id: payment.id, is_deleted: false });
      const association = associateRefundsToRequests({
        refunds: refundObjects,
        requests: reqs,
        paymentIntentId: piId,
        currency: payment.currency || charge.currency,
      });
      const matched = association.matched;
      // Processa o estorno com a lógica comum ao webhook e ao reconciler do
      // job agendado: cancela ingressos/participantes afetados, atribui o
      // valor cumulativo autoritativo, alerta ingresso já utilizado e
      // confirma a solicitação correspondente.
      // ===== P0-B — TRILHA OBRIGATÓRIA (estorno confirmado) =====
      // O dinheiro já voltou no Stripe: nada é reenviado ao provedor. Sem trilha
      // confirmada o estado local não é alterado e nenhuma tela informa sucesso;
      // o reenvio do Stripe (idempotente) conclui depois.
      const refundedAmountBRL = (Number(charge.amount_refunded) || 0) / 100;
      try {
        await writeMandatoryAudit(svc, {
          action: "status_change",
          entity_type: "Payment",
          entity_id: payment.id,
          user_id: "system",
          user_name: "Stripe",
          event_id: order.event_id,
          audit_key: buildAuditKey("estorno_confirmado", charge.id, charge.amount_refunded || 0),
          provider: "stripe",
          external_reference: charge.id,
          amount: refundedAmountBRL,
          details: JSON.stringify({
            type: "estorno_confirmado",
            order_id: order.id,
            payment_id: payment.id,
            intent_id: piId,
            charge_id: charge.id,
            refund_request_id: matched?.id || "",
            valor_estornado_acumulado: refundedAmountBRL,
            valor_pago: (Number(charge.amount) || 0) / 100,
          }),
        });
      } catch (auditErr: any) {
        await recordPendingTrail(svc, {
          action: "status_change",
          entity_type: "Payment",
          entity_id: payment.id,
          event_id: order.event_id,
          audit_key: buildAuditKey("estorno_confirmado", charge.id, charge.amount_refunded || 0),
          provider: "stripe",
          external_reference: charge.id,
          amount: refundedAmountBRL,
          failure_reason: auditErr?.message || String(auditErr),
          details: JSON.stringify({ type: "estorno_confirmado", order_id: order.id, payment_id: payment.id, intent_id: piId, charge_id: charge.id }),
        });
        console.error("[stripeWebhook] trilha obrigatória indisponível (refunded):", auditErr?.message || auditErr);
        return Response.json({ error: "auditoria indisponivel" }, { status: 500 });
      }

      // ===== SEM ASSOCIAÇÃO INEQUÍVOCA (P0.2) =====
      // Separação obrigatória: confirmação FINANCEIRA (sempre) ≠ associação da
      // solicitação (só com identidade) ≠ cancelamento de ingressos (só com
      // associação). Aqui o dinheiro devolvido é registrado e o evento fica
      // PENDENTE de associação — nenhum ingresso/participante/item é cancelado
      // por aproximação, e nada se perde do lado financeiro.
      if (!matched) {
        const financial = await applyUnassociatedRefundAmount(
          svc, payment, (charge.amount_refunded || 0), (charge.amount || 0)
        );
        const pendingTrail = {
          action: "status_change",
          entity_type: "RefundRequest",
          entity_id: "",
          user_id: "system",
          user_name: "Stripe",
          event_id: order.event_id,
          audit_key: buildAuditKey("estorno_sem_associacao", charge.id, charge.amount_refunded || 0),
          provider: "stripe",
          external_reference: charge.id,
          amount: financial.refundAmountBRL,
          details: JSON.stringify({
            type: "estorno_sem_associacao",
            motivo: association.reason,
            ambiguo: association.ambiguous,
            payment_id: payment.id,
            order_id: order.id,
            intent_id: piId,
            charge_id: charge.id,
            valor_estornado_acumulado: financial.refundAmountBRL,
            valor_pago: (Number(charge.amount) || 0) / 100,
            estornos_no_charge: refundObjects.map((r: any) => r.id),
          }),
        };
        try {
          await writeMandatoryAudit(svc, pendingTrail);
        } catch (trailErr: any) {
          await recordPendingTrail(svc, { ...pendingTrail, failure_reason: trailErr?.message || String(trailErr) });
          console.error("[stripeWebhook] trilha obrigatória indisponível (estorno sem associação):", trailErr?.message || trailErr);
          return Response.json({ error: "auditoria indisponivel" }, { status: 500 });
        }
        return Response.json({
          received: true,
          association: "pending",
          refundAmount: financial.refundAmountBRL,
          partial: financial.isPartial,
        });
      }

      // Associação inequívoca: grava o vínculo definitivo (se veio pela
      // metadata) e processa ingressos/participantes/itens desta solicitação.
      if (association.refund?.id && matched.stripe_refund_id !== association.refund.id) {
        try { await svc.entities.RefundRequest.update(matched.id, { stripe_refund_id: association.refund.id }); } catch {}
      }
      const outcome = await applyConfirmedStripeRefund(
        svc, payment, order, matched,
        (charge.amount_refunded || 0), (charge.amount || 0)
      );
      return Response.json({
        received: true,
        association: "matched",
        refundAmount: outcome.refundAmountBRL,
        partial: outcome.isPartial,
      });
    }

    // Unhandled event type — acknowledge so Stripe stops retrying.
    return Response.json({ received: true, skipped: evt.type });
  } catch (error: any) {
    console.error('[stripeWebhook] error:', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
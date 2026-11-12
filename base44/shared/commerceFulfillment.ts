// Commerce fulfillment + refund — shared, idempotent logic used by both the
// Stripe webhook (stripeWebhook) and the polling path (getPaymentStatus).
//
// INVARIANTS:
//   - Fulfillment is idempotent: re-running on an already-succeeded payment never
//     double-creates Participants/Tickets. Guarded by atomic Payment.fulfillment_status
//     claim (pending → fulfilled) + per-order_item Ticket existence check.
//   - On post-payment fulfillment failure: payment stays succeeded, fulfillment_status
//     becomes 'pending_retry' (surfaced in admin panel). The buyer's money is real;
//     fulfillment is retried/manually resolved. We NEVER silently lose a paid order.
//   - Lot quantity transitions: reserve on intent create, confirm (reserved→sold) on
//     success, release on failure/expire. Atomic $inc with guard.

import { generateTicketHash } from "./commercePolicy.ts";
import { releaseCheckoutLock } from "./checkoutLock.ts";
import { incUniqueParticipant, incParticipantsByRole, decUniqueParticipant, decParticipantsByRole } from "./businessMetrics.ts";
import { retrieveChargeWithBalance } from "./stripeClient.ts";
import { normalizeEmail, emailMatchVariants } from "./identity.ts";
import { deterministicCompare } from "./deterministicSurvivor.ts";
import { applyConfirmedRefundCents } from "./refundLedger.ts";

// Janela após a qual um fulfillment em estado intermediário 'fulfilling' é
// considerado crash (nenhum laço de emissão dura tanto) e pode ser retomado.
export const FULFILLING_STALE_MS = 10 * 60 * 1000;

// Resolve or create a Person by contact_email (companion may not have an account yet).
// Dedup com reativação: Person inativa com o mesmo e-mail é REATIVADA (a
// inscrição anterior cancelada/reembolsada não impede uma nova inscrição —
// a identidade existente volta), em vez de criar uma Person duplicada.
async function ensurePerson(svc: any, name: string, email: string, phone?: string): Promise<string> {
  // P1-A — e-mail canônico na gravação e na comparação. Se houver mais de um
  // cadastro com o mesmo e-mail, a escolha é DETERMINÍSTICA (created_date + id):
  // emitir ingresso não pode falhar por ambiguidade de cadastro, e todos os
  // caminhos (compra, retry, webhook) elegem o mesmo sobrevivente.
  const normalized = normalizeEmail(email);
  const existing = await svc.entities.Person.filter({
    contact_email: emailMatchVariants(email),
    is_active: { $ne: false },
  });
  const matches = (existing || [])
    .filter((p: any) => normalizeEmail(p.contact_email) === normalized)
    .sort(deterministicCompare);
  if (matches.length > 0) {
    if (matches[0].is_active === false) {
      try { await svc.entities.Person.update(matches[0].id, { is_active: true }); } catch {}
    }
    return matches[0].id;
  }
  const person = await svc.entities.Person.create({
    full_name: name,
    contact_email: normalized,
    phone: phone || "",
    is_active: true,
    created_day: new Date().toISOString().slice(0, 10),
    metrics_inc: true,
  });
  return person.id;
}

// Convida titulares (acompanhantes) sem conta de usuário no app. Idempotente:
// pula quem já é User; erros de invite são silenciados. Usa o client normal
// (autenticado) — chamado a partir do getPaymentStatus (buyer autenticado).
export async function ensureCompanionInvites(base44: any, svc: any, orderItems: any[]): Promise<void> {
  const emails = [...new Set(orderItems.map((i: any) => i.holder_email).filter(Boolean))];
  for (const email of emails) {
    try {
      const existing = await svc.entities.User.filter({ email });
      if (existing && existing.length > 0) continue;
      await base44.users.inviteUser(email, "user");
    } catch (err: any) {
      console.error("[ensureCompanionInvites] invite failed for", email, err?.message || err);
    }
  }
}

// Captura a taxa do Stripe (balance_transaction do charge) no Payment —
// idempotente (só preenche se ainda não foi). Usada no webhook E nos caminhos
// de polling/retry: pagamento confirmado fora do webhook não fica com taxa 0.
export async function captureStripeFee(svc: any, payment: any, chargeId: any): Promise<void> {
  if (!chargeId || payment.stripe_fee_amount) return;
  try {
    const charge = await retrieveChargeWithBalance(String(chargeId));
    const feeCents = charge?.balance_transaction?.fee;
    if (typeof feeCents === "number") {
      await svc.entities.Payment.update(payment.id, { stripe_fee_amount: feeCents / 100 });
    }
  } catch (err: any) {
    console.error("[captureStripeFee] failed:", err?.message || err);
  }
}

// Idempotent fulfillment: create Participants + Tickets for a paid order.
// Returns { fulfilled: boolean, tickets: string[], error?: string }.
export async function fulfillOrder(svc: any, payment: any, order: any, orderItems: any[]): Promise<{ fulfilled: boolean; tickets: any[]; error?: string }> {
  // P0 — Guarda de pedido cancelado: confirmação de pagamento (webhook OU
  // polling OU retry) que chega para um pedido JÁ cancelado/expirado NUNCA emite
  // ingressos nem participantes. O pagamento é marcado 'succeeded' (o dinheiro é
  // real e rastreável na aba de transações; o expirador nunca cancela pedidos
  // com pagamento vivo) e o evento é gravado no audit trail EXATAMENTE UMA VEZ
  // (CAS pending→succeeded: reentregas do Stripe não duplicam a auditoria).
  // O pedido cancelado não é alterado; a resolução (estorno) fica para a gestão.
  if (order && order.status === "cancelled") {
    const claim = await svc.entities.Payment.updateMany(
      { id: payment.id, status: "pending" },
      { $set: { status: "succeeded", error_reason: "Pagamento confirmado após o cancelamento do pedido — ingressos não emitidos; resolver com estorno." } }
    );
    if (claim && claim.updated) {
      try {
        await svc.entities.AuditLog.create({
          action: "status_change",
          entity_type: "Payment",
          entity_id: payment.id,
          details: JSON.stringify({
            type: "pagamento_pos_cancelamento_ignorado",
            status: "desconhecido_ignorado",
            order_id: order.id,
            payment_id: payment.id,
            intent_id: payment.intent_id || "",
            valor_pago: payment.amount,
          }),
          event_id: order.event_id,
          user_id: order.buyer_user_id,
        });
      } catch {}
    }
    const tickets = await svc.entities.Ticket.filter({ order_id: order.id, is_deleted: false });
    return { fulfilled: false, tickets, error: "Pedido já cancelado — pagamento registrado para resolução manual (estorno)." };
  }

  if (payment.fulfillment_status === "fulfilled") {
    const tickets = await svc.entities.Ticket.filter({ order_id: order.id, is_deleted: false });
    return { fulfilled: true, tickets };
  }

  // Claim atômico com ESTADO INTERMEDIÁRIO 'fulfilling' — distinto de 'fulfilled'
  // enquanto o laço de emissão roda. Um crash no meio deixa o pagamento em
  // 'fulfilling' (NUNCA 'fulfilled' com emissão pela metade): recuperável pelo
  // retryFulfillment e pelo reconciler do job de expiração quando stalo.
  if (payment.fulfillment_status === "fulfilling") {
    const claimedAt = payment.updated_date ? new Date(payment.updated_date).getTime() : 0;
    if (Date.now() - claimedAt < FULFILLING_STALE_MS) {
      // Outro laço de emissão está vivo agora — não concorre com ele.
      const tickets = await svc.entities.Ticket.filter({ order_id: order.id, is_deleted: false });
      return { fulfilled: true, tickets };
    }
    // 'fulfilling' stalo = crash antigo. Recupera para pending_retry; o claim
    // normal abaixo retoma a emissão de onde parou (idempotente por item).
    await svc.entities.Payment.updateMany(
      { id: payment.id, fulfillment_status: "fulfilling" },
      { $set: { fulfillment_status: "pending_retry", error_reason: "Emissão interrompida (crash) — retomada automaticamente." } }
    );
    payment = { ...payment, fulfillment_status: "pending_retry" };
  }
  const claim = await svc.entities.Payment.updateMany(
    { id: payment.id, fulfillment_status: { $in: ["pending", "pending_retry"] } },
    { $set: { fulfillment_status: "fulfilling", status: "succeeded", succeeded_at: payment.succeeded_at || new Date().toISOString() } }
  );
  if (!claim || !claim.updated) {
    // Another caller is fulfilling or already done.
    const tickets = await svc.entities.Ticket.filter({ order_id: order.id, is_deleted: false });
    return { fulfilled: true, tickets };
  }

  const createdTickets: any[] = [];
  const event = (await svc.entities.Event.filter({ id: order.event_id }))[0];

  // P2 — Uso do cupom contabilizado no pagamento confirmado (nunca na criação do
  // pedido). Marker atômico no Order: retentativas de fulfillment não contam duas
  // vezes; o estorno integral reseta o marker e devolve o uso.
  if (order.coupon_id) {
    try {
      const marked = await svc.entities.Order.updateMany(
        { id: order.id, coupon_uses_counted: { $ne: true } },
        { $set: { coupon_uses_counted: true } }
      );
      if (marked && marked.updated) {
        const coupon = (await svc.entities.Coupon.filter({ id: order.coupon_id }))[0];
        if (coupon) {
          await svc.entities.Coupon.updateMany(
            { id: coupon.id, uses_count: { $lt: coupon.max_uses || Number.MAX_SAFE_INTEGER } },
            { $inc: { uses_count: 1 } }
          );
        }
      }
    } catch (err: any) {
      console.error("[fulfillOrder] coupon count failed:", err?.message || err);
    }
  }

  try {
    for (const item of orderItems) {
      // Idempotency per item: skip if ticket already issued AND participant linked.
      const existingTicket = await svc.entities.Ticket.filter({ order_item_id: item.id, is_deleted: false });
      let ticket = existingTicket[0];
      if (!ticket) {
        // Ensure Person for the holder.
        const personId = await ensurePerson(svc, item.holder_name, item.holder_email, item.holder_phone);

        // Issue Ticket FIRST (participant linked right after): a retry never
        // duplicates the Participant — the ticket existence check above guards it.
        ticket = await svc.entities.Ticket.create({
          order_id: order.id,
          order_item_id: item.id,
          event_id: order.event_id,
          ticket_type_id: item.ticket_type_id,
          ticket_type_name: item.ticket_type_name,
          lot_id: item.lot_id,
          person_id: personId,
          participant_id: "",
          holder_name: item.holder_name,
          holder_email: item.holder_email,
          hash_code: generateTicketHash(),
          status: "issued",
        });

        // Link ticket back to the order item.
        await svc.entities.OrderItem.update(item.id, { ticket_id: ticket.id });

        // Confirm lot: reserved → sold (atomic).
        await svc.entities.SalesLot.updateMany(
          { id: item.lot_id },
          { $inc: { quantity_reserved: -1, quantity_sold: 1 } }
        );
      }
      createdTickets.push(ticket);

      // 1 ingresso = 1 Participant — cada ingresso tem seu PRÓPRIO registro na
      // lista de participantes do evento (nunca reutiliza o registro de outro
      // ingresso): estornar um ingresso cancela só a inscrição dele, e a mesma
      // pessoa pode ter N entradas se tiver N ingressos.
      if (!ticket.participant_id) {
        // Reconciliação de órfão (P3): se uma tentativa anterior crashou entre
        // criar o participante e vinculá-lo no ingresso, ficou um participante
        // SEM nenhum Ticket apontando para ele. Antes de criar um SEGUNDO
        // participante para este ingresso, adota um órfão da mesma pessoa
        // (person_id + event_id, criado após este pedido) que não esteja
        // vinculado a nenhum Ticket.
        let part: any = null;
        if (ticket.person_id) {
          try {
            const orderCreated = order.created_date ? new Date(order.created_date).getTime() : 0;
            const candidates = await svc.entities.Participant.filter({
              event_id: order.event_id,
              person_id: ticket.person_id,
              registration_status: { $ne: "cancelled" },
              is_deleted: false,
            });
            for (const cand of candidates) {
              const candCreated = cand.created_date ? new Date(cand.created_date).getTime() : 0;
              if (orderCreated && candCreated < orderCreated) continue;
              const linked = await svc.entities.Ticket.filter({ participant_id: cand.id, is_deleted: false });
              if (linked.length === 0) { part = cand; break; }
            }
          } catch {}
        }
        if (!part) {
          part = await svc.entities.Participant.create({
            event_id: order.event_id,
            full_name: item.holder_name,
            email: item.holder_email,
            phone: item.holder_phone || "",
            person_id: ticket.person_id,
            role_in_event: "attendee",
            registration_status: "confirmed",
            checkin_status: "pending",
            created_day: new Date().toISOString().slice(0, 10),
            is_eligible: true,
            is_deleted: false,
          });
          try { await incUniqueParticipant(svc, order.event_id, part.created_date); } catch {}
          try { await incParticipantsByRole(svc, order.event_id, "attendee", part.created_date); } catch {}
        }
        await svc.entities.Ticket.update(ticket.id, { participant_id: part.id });
      }
    }

    // Mark order fulfilled.
    await svc.entities.Order.update(order.id, { status: "paid", fulfillment_status: "fulfilled" });
    await svc.entities.Payment.update(payment.id, { status: "succeeded", fulfillment_status: "fulfilled", succeeded_at: new Date().toISOString() });

    // FIN-001 — pagamento confirmado: libera (idempotente) o lock de checkout
    // do comprador — a exclusividade deixa de ser necessária.
    await releaseCheckoutLock(svc, order.buyer_person_id, order.event_id);

    // Audit.
    try {
      await svc.entities.AuditLog.create({
        action: "create",
        entity_type: "Order",
        entity_id: order.id,
        details: JSON.stringify({
          type: "ticket_fulfillment",
          tickets: createdTickets.length,
          payment_id: payment.id,
          intent_id: payment.intent_id,
          valor_pago: payment.amount,
          moeda: payment.currency || "BRL",
        }),
        event_id: order.event_id,
        user_id: order.buyer_user_id,
      });
    } catch {}

    return { fulfilled: true, tickets: createdTickets };
  } catch (err: any) {
    // Fulfillment partially failed — flag for manual resolution. Payment stays succeeded.
    await svc.entities.Payment.update(payment.id, { fulfillment_status: "pending_retry", error_reason: err?.message || String(err) });
    await svc.entities.Order.update(order.id, { fulfillment_status: "pending_retry" });
    try {
      await svc.entities.AuditLog.create({
        action: "status_change",
        entity_type: "Order",
        entity_id: order.id,
        details: JSON.stringify({
          type: "ticket_fulfillment_failed",
          error: err?.message || String(err),
          payment_id: payment.id,
          intent_id: payment.intent_id,
          valor_pago: payment.amount,
        }),
        event_id: order.event_id,
        user_id: order.buyer_user_id,
      });
    } catch {}
    return { fulfilled: false, tickets: createdTickets, error: err?.message || String(err) };
  }
}

// Release reserved lot quantities (on payment failure/abandon/expire).
export async function releaseReservations(svc: any, orderItems: any[]): Promise<void> {
  for (const item of orderItems) {
    try {
      await svc.entities.SalesLot.updateMany(
        { id: item.lot_id, quantity_reserved: { $gte: 1 } },
        { $inc: { quantity_reserved: -1 } }
      );
    } catch {}
  }
}

// FIN-002 — Reserva ATÔMICA do uso do cupom no checkout (antes de devolver o
// client_secret): CAS uses_count < max_uses + $inc. Checkouts concorrentes não
// conseguem reservar além do teto — a validação de carrinho (não-atômica) não
// basta. Cupons ilimitados (max_uses=0) não reservam nem contam (comportamento
// preservado: contados no fulfillment, sem teto).
export async function reserveCouponUse(svc: any, coupon: any): Promise<boolean> {
  if (!coupon || !(Number(coupon.max_uses) > 0)) return true;
  const res = await svc.entities.Coupon.updateMany(
    { id: coupon.id, uses_count: { $lt: Number(coupon.max_uses) } },
    { $inc: { uses_count: 1 } }
  );
  return !!(res && res.updated);
}

// FIN-002 — Devolve o uso do cupom reservado por um pedido (expiração,
// cancelamento, re-checkout com novo carrinho). EXATAMENTE-UMA-VEZ via CAS no
// marker do pedido (coupon_uses_counted): reexecuções (webhook duplicado,
// re-varredura do expirador, polling) não devolvem duas vezes.
export async function releaseCouponUse(svc: any, order: any): Promise<void> {
  if (!order || !order.coupon_id || order.coupon_uses_counted !== true) return;
  try {
    const unmarked = await svc.entities.Order.updateMany(
      { id: order.id, coupon_uses_counted: true },
      { $set: { coupon_uses_counted: false } }
    );
    if (unmarked && unmarked.updated) {
      await svc.entities.Coupon.updateMany(
        { id: order.coupon_id, uses_count: { $gt: 0 } },
        { $inc: { uses_count: -1 } }
      );
    }
  } catch (err: any) {
    console.error("[releaseCouponUse] failed:", err?.message || err);
  }
}

// Encerra um pagamento cujo PaymentIntent foi cancelado — EXATAMENTE UMA VEZ
// (P0): CAS duplo — só a chamada que executa pending→expired no Payment devolve
// as reservas, e só a que executa pending→cancelled no Order encerra o pedido.
// Entregas duplicadas do webhook payment_intent.canceled e a sobreposição
// polling→webhook NÃO devolvem a mesma reserva duas vezes (anti-oversell).
export async function expirePaymentOnce(svc: any, payment: any): Promise<{ expiredNow: boolean }> {
  const claim = await svc.entities.Payment.updateMany(
    { id: payment.id, status: "pending" },
    { $set: { status: "expired", error_reason: "Checkout cancelado/abandonado." } }
  );
  if (!claim || !claim.updated) return { expiredNow: false };

  // Só encerra o pedido se NÃO houver outra transação viva nele — ex.: checkout
  // reaberto criou um novo PaymentIntent sobre o MESMO pedido; derrubar o pedido
  // aqui cancelaria uma compra em andamento. Reservas seguem presas enquanto o
  // novo intent estiver aberto.
  const siblings = await svc.entities.Payment.filter({ order_id: payment.order_id, is_deleted: false });
  const hasLiveSibling = siblings.some((p: any) => p.id !== payment.id && (
    p.status === "pending" || p.status === "succeeded" ||
    p.fulfillment_status === "pending_retry" || p.fulfillment_status === "fulfilled"
  ));
  if (hasLiveSibling) return { expiredNow: true };

  // Encerramento do pedido via CAS; quem executa a transição devolve as
  // reservas e invalida os itens — um webhook canceled posterior (duplicado)
  // não devolve a reserva de novo.
  const orderClaim = await svc.entities.Order.updateMany(
    { id: payment.order_id, status: "pending" },
    { $set: { status: "cancelled" } }
  );
  if (orderClaim && orderClaim.updated) {
    // FIN-002 — devolve o uso do cupom reservado pelo checkout abandonado.
    const orderRec = (await svc.entities.Order.filter({ id: payment.order_id }))[0];
    await releaseCouponUse(svc, orderRec);
    const orderItems = await svc.entities.OrderItem.filter({ order_id: payment.order_id, is_deleted: false });
    await releaseReservations(svc, orderItems);
    for (let k = 0; k < orderItems.length; k++) {
      try { await svc.entities.OrderItem.update(orderItems[k].id, { is_deleted: true }); } catch {}
    }
  }
  return { expiredNow: true };
}

// Processa um estorno CONFIRMADO no Stripe para um pagamento — usado pelo
// webhook charge.refunded E pelo reconciler de estornos do job agendado
// (quando o webhook não chegou). Idempotente: reexecuções convergem para o
// mesmo estado (ingressos/participantes cancelados, valor cumulativo
// autoritativo atribuído, status do pedido/pagamento, solicitação confirmada).
export async function applyConfirmedStripeRefund(
  svc: any,
  payment: any,
  order: any,
  matched: any,
  cumulativeRefundedCents: number,
  chargeAmountCents: number,
): Promise<{ ok: boolean; usedSkipped: number; isPartial: boolean; refundAmountBRL: number; reason?: string }> {
  const refundAmountBRL = (cumulativeRefundedCents || 0) / 100;
  const isPartial = (cumulativeRefundedCents || 0) < (chargeAmountCents || 0);
  // Per-item: se a solicitação casada for cancel_item, cancela só esses itens.
  const orderItemIds = matched && matched.refund_type === "cancel_item"
    && Array.isArray(matched.order_item_ids) && matched.order_item_ids.length > 0
    ? matched.order_item_ids
    : undefined;
  const outcome = await processRefundSuccess(
    svc, payment, order, refundAmountBRL, isPartial, orderItemIds, matched?.id,
    // P1.1 — a confirmação consome a reserva DESTA solicitação na mesma escrita.
    Math.round((Number(matched?.amount_requested) || 0) * 100),
  );

  // P0.1 (patch final Fase 1) — FALHA DO LEDGER NÃO CONCLUI O ESTORNO.
  // Nada foi concluído localmente (ingressos/participantes/itens intactos,
  // Payment e Order no status anterior). A solicitação NÃO vira 'processed': o
  // webhook responde 500 e o reconciler retenta — a confirmação é cumulativa,
  // então a repetição converge sem contar o valor duas vezes.
  if (!outcome.ok) {
    console.error(
      "[applyConfirmedStripeRefund] processamento local NÃO concluído (ledger):",
      outcome.reason, "| payment:", payment?.id, "| request:", matched?.id || "",
    );
    return {
      ok: false, usedSkipped: 0, isPartial, refundAmountBRL,
      reason: outcome.reason || "Ledger de estorno indisponível.",
    };
  }

  if (outcome.usedSkipped > 0) {
    // Estorno sobre ingresso já utilizado (P3): o dinheiro voltou (Stripe é
    // autoritativo), mas o ingresso UTILIZADO não é cancelado silenciosamente —
    // alerta o admin (auditoria + solicitação marcada). Reverter o check-in é
    // pré-requisito para tratar.
    try {
      await svc.entities.AuditLog.create({
        action: "status_change",
        entity_type: "Payment",
        entity_id: payment.id,
        details: JSON.stringify({
          type: "refund_used_ticket_blocked",
          used_skipped: outcome.usedSkipped,
          payment_id: payment.id,
          intent_id: payment.intent_id,
          valor_pago: payment.amount,
          valor_estornado_acumulado: refundAmountBRL,
          stripe_refund_id: matched?.stripe_refund_id || "",
          refund_request_id: matched?.id || "",
        }),
        event_id: order.event_id,
        user_id: order.buyer_user_id,
      });
    } catch (usedErr: any) {
      console.error("[applyConfirmedStripeRefund] used-ticket audit failed:", usedErr?.message || usedErr);
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
  // estorno no Stripe — quem processa é o webhook/reconciler).
  try {
    if (matched && matched.status !== "processed" && matched.status !== "failed") {
      await svc.entities.RefundRequest.update(matched.id, {
        status: "processed",
        processed_at: new Date().toISOString(),
        amount_refunded: matched.amount_requested || refundAmountBRL,
      });
    }
  } catch (reqErr: any) {
    console.error("[applyConfirmedStripeRefund] refund request confirm failed:", reqErr?.message || reqErr);
  }

  return { ok: true, usedSkipped: outcome.usedSkipped, isPartial, refundAmountBRL };
}

// P0.2 (patch Fase 1) — CONFIRMAÇÃO FINANCEIRA SEM ASSOCIAÇÃO.
// O dinheiro voltou no Stripe, mas não há como provar a QUAL solicitação o
// estorno pertence. Aqui SÓ o lado financeiro é reconciliado (valor confirmado
// cumulativo + status do pagamento). Ingressos, participantes e itens de pedido
// NÃO são tocados: cancelar por aproximação poderia consumir os ingressos
// errados. A associação pendente fica registrada para reconciliação.
export async function applyUnassociatedRefundAmount(
  svc: any,
  payment: any,
  cumulativeRefundedCents: number,
  chargeAmountCents: number,
): Promise<{ ok: boolean; isPartial: boolean; refundAmountBRL: number; applied: boolean; reason?: string }> {
  const cumulative = Math.max(0, Math.round(Number(cumulativeRefundedCents) || 0));
  const applied = await applyConfirmedRefundCents(svc, payment, cumulative);
  const isPartial = cumulative < Math.max(0, Math.round(Number(chargeAmountCents) || 0));

  // P0.1 (patch final Fase 1) — sem ledger confirmado o pagamento NÃO é
  // declarado estornado. O valor devolvido pelo Stripe continua na trilha
  // obrigatória do webhook (`estorno_confirmado` / `estorno_sem_associacao`,
  // com charge e valor acumulado) e a confirmação é retomada na repetição.
  if (!applied.ok) {
    console.error(
      "[applyUnassociatedRefundAmount] ledger indisponível — status do pagamento NÃO alterado:",
      applied.reason, "| payment:", payment?.id,
    );
    return {
      ok: false, isPartial, refundAmountBRL: cumulative / 100, applied: false,
      reason: applied.reason || "Ledger de estorno indisponível.",
    };
  }

  try {
    await svc.entities.Payment.update(payment.id, { status: isPartial ? "partially_refunded" : "refunded" });
  } catch (err: any) {
    console.error("[applyUnassociatedRefundAmount] payment status update failed:", err?.message || err);
    return {
      ok: false, isPartial, refundAmountBRL: cumulative / 100, applied: false,
      reason: "Status do pagamento não confirmado neste processamento.",
    };
  }
  return { ok: true, isPartial, refundAmountBRL: cumulative / 100, applied: applied.applied };
}

// Process a successful refund: cancel participants + tickets + counters (MetricBucket).
//
// P0.1 (patch final Fase 1) — O LEDGER É O PORTÃO FINANCEIRO.
// O valor confirmado do Stripe é aplicado ANTES de qualquer efeito operacional.
// Se o ledger não pôde ser normalizado/confirmado: NENHUM ingresso/participante/
// item é cancelado, Payment e Order mantêm o status anterior e a função retorna
// ok=false. A devolução do dinheiro continua registrada no Stripe (fonte de
// verdade) e na trilha obrigatória do chamador; o processamento local fica
// PENDENTE e recuperável pelo reenvio do webhook / reconciler. A confirmação é
// monotônica (cumulativa), então a repetição não conta o valor duas vezes.
export async function processRefundSuccess(svc: any, payment: any, order: any, refundAmountBRL: number, isPartial: boolean, orderItemIds?: string[], refundRequestId?: string, reservationCents?: number): Promise<{ ok: boolean; usedSkipped: number; reason?: string }> {
  // (1) PORTÃO FINANCEIRO — nada abaixo roda se o ledger não confirmar.
  const ledger = await applyConfirmedRefundCents(svc, payment, Math.round((Number(refundAmountBRL) || 0) * 100), {
    releaseRequestId: refundRequestId,
    releaseCents: reservationCents,
  });
  if (!ledger.ok) {
    console.error(
      "[processRefundSuccess] ledger indisponível — processamento local NÃO concluído:",
      ledger.reason, "| payment:", payment?.id, "| order:", order?.id, "| request:", refundRequestId || "",
    );
    return { ok: false, usedSkipped: 0, reason: ledger.reason || "Ledger de estorno indisponível." };
  }

  let usedSkipped = 0;
  const orderItems = await svc.entities.OrderItem.filter({ order_id: order.id, is_deleted: false });
  const tickets = await svc.entities.Ticket.filter({ order_id: order.id, is_deleted: false });
  const targetItemIds = orderItemIds && orderItemIds.length > 0 ? new Set(orderItemIds) : null;
  const relevantTickets = targetItemIds ? tickets.filter((t: any) => targetItemIds.has(t.order_item_id)) : tickets;

  // Regra-mestre: TODO estorno cancela os ingressos/participantes afetados. Full/partial
  // (por valor) cancelam todos; cancel_item cancela apenas os itens selecionados, cada
  // um com seu próprio participante (1 ingresso = 1 registro). O VALOR devolvido varia
  // pela política de prazo (100%–0%) e é independente do cancelamento da participação.
  for (const ticket of relevantTickets) {
    if (ticket.status === "cancelled" || ticket.status === "refunded") continue;
    // Trava pós-check-in (P3): ingresso UTILIZADO nunca é cancelado
    // silenciosamente (estorno direto no painel do Stripe) — o ingresso segue
    // válido e o chamador alerta (webhook marca a solicitação + auditoria).
    if (ticket.status === "used") { usedSkipped++; continue; }
    // CONC-001: o estorno confirmado consome a trava — limpa o dono dela.
    await svc.entities.Ticket.update(ticket.id, { status: "refunded", refund_request_id: null });
    if (ticket.participant_id) {
      const part = (await svc.entities.Participant.filter({ id: ticket.participant_id }))[0];
      if (part && part.registration_status !== "cancelled") {
        await svc.entities.Participant.update(ticket.participant_id, { registration_status: "cancelled" });
        try { await decUniqueParticipant(svc, order.event_id, part.created_date); } catch {}
        try { await decParticipantsByRole(svc, order.event_id, part.role_in_event || "attendee", part.created_date); } catch {}
      }
    }
    await svc.entities.OrderItem.update(ticket.order_item_id, { refunded: true });
    // Decrement sold quantity back.
    await svc.entities.SalesLot.updateMany({ id: ticket.lot_id }, { $inc: { quantity_sold: -1 } });
  }

  // P1.1 — o valor confirmado já foi aplicado no PORTÃO acima (o ledger nunca é
  // tocado aqui). Só agora, com o financeiro consolidado, os status locais.
  const newStatus = isPartial ? "partially_refunded" : "refunded";
  await svc.entities.Payment.update(payment.id, { status: newStatus });
  await svc.entities.Order.update(order.id, { status: isPartial ? "partially_refunded" : "refunded" });

  // P2 — Estorno integral devolve o uso do cupom ao invés contabilizado
  // (marker reseta; um novo pagamento do pedido contaria o uso de novo).
  if (!isPartial && order.coupon_id) {
    try {
      const unmarked = await svc.entities.Order.updateMany(
        { id: order.id, coupon_uses_counted: true },
        { $set: { coupon_uses_counted: false } }
      );
      if (unmarked && unmarked.updated) {
        await svc.entities.Coupon.updateMany(
          { id: order.coupon_id, uses_count: { $gt: 0 } },
          { $inc: { uses_count: -1 } }
        );
      }
    } catch (err: any) {
      console.error("[processRefundSuccess] coupon return failed:", err?.message || err);
    }
  }

  try {
    await svc.entities.AuditLog.create({
      action: "status_change",
      entity_type: "Order",
      entity_id: order.id,
      details: JSON.stringify({
        type: "ticket_refund",
        amount: refundAmountBRL,
        partial: isPartial,
        valor_pago: payment.amount,
        valor_estornado_acumulado: refundAmountBRL,
        payment_id: payment.id,
        intent_id: payment.intent_id,
        refund_request_id: refundRequestId || "",
      }),
      event_id: order.event_id,
      user_id: order.buyer_user_id,
    });
  } catch {}
  return { ok: true, usedSkipped };
}

// ===== Trava anti-corrida estorno × check-in (P0 TOCTOU) =====
//
// requestRefund trava os ingressos afetados de 'issued' → 'refund_pending'
// com CAS ANTES de disparar o estorno no Stripe: nenhum check-in aceita o
// ingresso no intervalo entre a solicitação e a confirmação. O webhook
// charge.refunded (processRefundSuccess) move refund_pending → refunded; a
// falha/recusa do estorno destrava de volta para issued.

// Trava os ingressos (CAS issued → refund_pending). Retorna false se QUALQUER
// ingresso mudou de estado entre a leitura e a trava (ex.: check-in confirmado
// agora) — nesse caso a trava parcial é revertida e o estorno NÃO dispara:
// dinheiro devolvido com ingresso válido deixa de existir.
//
// CONC-001 (2026-10-17) — Propriedade da trava: cada ingresso travado é
// carimbado com o refund_request_id do dono (o $set na MESMA escrita atômica
// do claim — sem segunda ida ao banco). O rollback da trava parcial é ESCOPADO
// por esse dono: sem ele, a compensação de uma segunda solicitação concorrente
// (que falhou no CAS sobre ingressos já refund_pending da primeira) REVERTIA as
// travas alheias e reabria a janela de check-in durante o estorno alheio.
export async function lockTicketsForRefund(svc: any, ticketIds: string[], refundRequestId?: string): Promise<boolean> {
  // P0.2 (2026-11-12) — SEM DONO NÃO HÁ TRAVA. Uma operação sem
  // refund_request_id não pode carimbar (nem depois liberar) ingresso nenhum:
  // era por aí que a compensação de uma solicitação alcançava ingressos de outra.
  if (!refundRequestId) {
    console.error("[lockTicketsForRefund] recusado: refund_request_id obrigatório.");
    return false;
  }
  if (!ticketIds || ticketIds.length === 0) return true;
  // Claim condicional: só ingresso LIVRE (issued e sem dono) entra na trava, com
  // o dono carimbado na MESMA escrita atômica. Ingresso já travado por outra
  // solicitação não casa e derruba a operação inteira.
  const claim = await svc.entities.Ticket.updateMany(
    {
      id: { $in: ticketIds },
      status: "issued",
      $or: [{ refund_request_id: { $exists: false } }, { refund_request_id: null }],
    },
    { $set: { status: "refund_pending", refund_request_id: refundRequestId } }
  );
  const locked = claim && claim.updated ? claim.updated : 0;
  if (locked === ticketIds.length) return true;
  // Reverte APENAS os ingressos travados por ESTA solicitação — nada fica
  // travado sem estorno em andamento e nenhuma trava alheia é tocada.
  try {
    await svc.entities.Ticket.updateMany(
      { id: { $in: ticketIds }, status: "refund_pending", refund_request_id: refundRequestId },
      { $set: { status: "issued", refund_request_id: null } }
    );
  } catch (err: any) {
    console.error("[lockTicketsForRefund] rollback failed:", err?.message || err);
  }
  return false;
}

// Destrava refund_pending → issued quando o estorno falhou/foi recusado no
// Stripe. Idempotente por CAS: só reativa exatamente o que ainda está travado
// (estorno confirmado já moveu os ingressos para 'refunded' — não é tocado).
//
// P0.2 (2026-11-12) — ESCOPO ESTRITO POR DONO, SEM FALLBACK GENÉRICO.
// A liberação exige o refund_request_id e toca EXCLUSIVAMENTE ingressos
// refund_pending carimbados com ele. O fallback antigo (liberar também travas
// legadas sem carimbo, e liberar TUDO quando não havia dono) permitia que uma
// solicitação alcançasse ingressos de outra — foi removido do caminho normal.
// Ingressos legados sem carimbo só saem de refund_pending pelo caminho
// administrativo explícito (releaseLegacyRefundLocks), com escopo, validação e
// trilha próprios.
export async function unlockTicketsForRefund(svc: any, orderId: string, orderItemIds?: string[], refundRequestId?: string): Promise<{ released: number }> {
  if (!refundRequestId) {
    console.error("[unlockTicketsForRefund] recusado: refund_request_id obrigatório (nenhuma trava liberada).");
    return { released: 0 };
  }
  const query: any = { order_id: orderId, status: "refund_pending", refund_request_id: refundRequestId };
  if (orderItemIds && orderItemIds.length > 0) query.order_item_id = { $in: orderItemIds };
  try {
    const res = await svc.entities.Ticket.updateMany(query, { $set: { status: "issued", refund_request_id: null } });
    return { released: res && res.updated ? res.updated : 0 };
  } catch (err: any) {
    console.error("[unlockTicketsForRefund] failed:", err?.message || err);
    return { released: 0 };
  }
}
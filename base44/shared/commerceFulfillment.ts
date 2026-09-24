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
import { incUniqueParticipant, incParticipantsByRole, decUniqueParticipant, decParticipantsByRole } from "./businessMetrics.ts";
import { retrieveChargeWithBalance } from "./stripeClient.ts";

// Janela após a qual um fulfillment em estado intermediário 'fulfilling' é
// considerado crash (nenhum laço de emissão dura tanto) e pode ser retomado.
export const FULFILLING_STALE_MS = 10 * 60 * 1000;

// Resolve or create a Person by contact_email (companion may not have an account yet).
async function ensurePerson(svc: any, name: string, email: string, phone?: string): Promise<string> {
  const existing = await svc.entities.Person.filter({ contact_email: email, is_active: true });
  if (existing.length > 0) return existing[0].id;
  const person = await svc.entities.Person.create({
    full_name: name,
    contact_email: email,
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

    // Audit.
    try {
      await svc.entities.AuditLog.create({
        action: "create",
        entity_type: "Order",
        entity_id: order.id,
        details: JSON.stringify({ type: "ticket_fulfillment", tickets: createdTickets.length }),
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
        details: JSON.stringify({ type: "ticket_fulfillment_failed", error: err?.message || String(err) }),
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

// Process a successful refund: cancel participants + tickets + EventStats.
export async function processRefundSuccess(svc: any, payment: any, order: any, refundAmountBRL: number, isPartial: boolean, orderItemIds?: string[]): Promise<{ usedSkipped: number }> {
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
    await svc.entities.Ticket.update(ticket.id, { status: "refunded" });
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

  // refundAmountBRL é o valor CUMULATIVO e autoritativo do Stripe
  // (charge.amount_refunded/100) — atribuído, nunca somado: eventos repetidos
  // do webhook/retries sempre convergem para o mesmo valor (idempotente).
  const newStatus = isPartial ? "partially_refunded" : "refunded";
  await svc.entities.Payment.update(payment.id, {
    status: newStatus,
    refunded_amount: refundAmountBRL,
  });
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
      details: JSON.stringify({ type: "ticket_refund", amount: refundAmountBRL, partial: isPartial }),
      event_id: order.event_id,
      user_id: order.buyer_user_id,
    });
  } catch {}
  return { usedSkipped };
}
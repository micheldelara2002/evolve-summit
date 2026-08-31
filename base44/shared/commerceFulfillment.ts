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

// Idempotent fulfillment: create Participants + Tickets for a paid order.
// Returns { fulfilled: boolean, tickets: string[], error?: string }.
export async function fulfillOrder(svc: any, payment: any, order: any, orderItems: any[]): Promise<{ fulfilled: boolean; tickets: any[]; error?: string }> {
  // Atomic claim: only one caller transitions fulfillment pending→fulfilled.
  if (payment.fulfillment_status === "fulfilled") {
    const tickets = await svc.entities.Ticket.filter({ order_id: order.id, is_deleted: false });
    return { fulfilled: true, tickets };
  }
  const claim = await svc.entities.Payment.updateMany(
    { id: payment.id, fulfillment_status: "pending" },
    { $set: { fulfillment_status: "fulfilled", status: "succeeded", succeeded_at: new Date().toISOString() } }
  );
  if (!claim || !claim.updated) {
    // Another caller is fulfilling or already done.
    const tickets = await svc.entities.Ticket.filter({ order_id: order.id, is_deleted: false });
    return { fulfilled: true, tickets };
  }

  const createdTickets: any[] = [];
  const event = (await svc.entities.Event.filter({ id: order.event_id }))[0];

  try {
    for (const item of orderItems) {
      // Idempotency per item: skip if ticket already issued for this order_item.
      const existingTicket = await svc.entities.Ticket.filter({ order_item_id: item.id, is_deleted: false });
      if (existingTicket.length > 0) {
        createdTickets.push(existingTicket[0]);
        continue;
      }
      // Ensure Person for the holder.
      const personId = await ensurePerson(svc, item.holder_name, item.holder_email, item.holder_phone);

      // Create Participant in the event (registration_status 'paid').
      const existingPart = await svc.entities.Participant.filter({
        event_id: order.event_id, person_id: personId, is_deleted: false,
      });
      let participantId: string;
      if (existingPart.length > 0 && existingPart[0].registration_status !== "cancelled") {
        // Already a participant — mark confirmed/paid if not already.
        participantId = existingPart[0].id;
        if (existingPart[0].registration_status !== "confirmed") {
          await svc.entities.Participant.update(participantId, { registration_status: "confirmed" });
        }
      } else if (existingPart.length > 0 && existingPart[0].registration_status === "cancelled") {
        // Reactivate a cancelled registration.
        participantId = existingPart[0].id;
        await svc.entities.Participant.update(participantId, { registration_status: "confirmed", is_deleted: false, created_day: new Date().toISOString().slice(0, 10) });
        try { await incUniqueParticipant(svc, order.event_id, new Date().toISOString()); } catch {}
      } else {
        const part = await svc.entities.Participant.create({
          event_id: order.event_id,
          full_name: item.holder_name,
          email: item.holder_email,
          phone: item.holder_phone || "",
          person_id: personId,
          role_in_event: "attendee",
          registration_status: "confirmed",
          checkin_status: "pending",
          created_day: new Date().toISOString().slice(0, 10),
          is_eligible: true,
          is_deleted: false,
        });
        participantId = part.id;
        try { await incUniqueParticipant(svc, order.event_id, part.created_date); } catch {}
        try { await incParticipantsByRole(svc, order.event_id, "attendee", part.created_date); } catch {}
      }

      // Issue Ticket.
      const ticket = await svc.entities.Ticket.create({
        order_id: order.id,
        order_item_id: item.id,
        event_id: order.event_id,
        ticket_type_id: item.ticket_type_id,
        ticket_type_name: item.ticket_type_name,
        lot_id: item.lot_id,
        person_id: personId,
        participant_id: participantId,
        holder_name: item.holder_name,
        holder_email: item.holder_email,
        hash_code: generateTicketHash(),
        status: "issued",
      });
      createdTickets.push(ticket);

      // Link ticket back to the order item.
      await svc.entities.OrderItem.update(item.id, { ticket_id: ticket.id });

      // Confirm lot: reserved → sold (atomic).
      await svc.entities.SalesLot.updateMany(
        { id: item.lot_id },
        { $inc: { quantity_reserved: -1, quantity_sold: 1 } }
      );
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
export async function processRefundSuccess(svc: any, payment: any, order: any, refundAmountBRL: number, isPartial: boolean, orderItemIds?: string[]): Promise<void> {
  const orderItems = await svc.entities.OrderItem.filter({ order_id: order.id, is_deleted: false });
  const tickets = await svc.entities.Ticket.filter({ order_id: order.id, is_deleted: false });
  const targetItemIds = orderItemIds && orderItemIds.length > 0 ? new Set(orderItemIds) : null;
  const relevantTickets = targetItemIds ? tickets.filter((t: any) => targetItemIds.has(t.order_item_id)) : tickets;

  // For full refund: cancel all. For partial: we cancel proportionally (simplest: cancel
  // the items whose unit_price sums to ~refundAmount; here we cancel all and mark order
  // partially_refunded — full cancel is the supported primary path).
  for (const ticket of relevantTickets) {
    if (ticket.status === "cancelled" || ticket.status === "refunded") continue;
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

  const newStatus = isPartial ? "partially_refunded" : "refunded";
  await svc.entities.Payment.update(payment.id, {
    status: newStatus,
    refunded_amount: (payment.refunded_amount || 0) + refundAmountBRL,
  });
  await svc.entities.Order.update(order.id, { status: isPartial ? "partially_refunded" : "refunded" });

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
}
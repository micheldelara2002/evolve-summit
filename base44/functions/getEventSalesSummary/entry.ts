import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

// Resumo de vendas de um evento para o gerente/admin: ingressos vendidos,
// receita total, ingressos emitidos, check-ins realizados. Agrega Payment
// (succeeded) + Ticket (issued/used) + Participant (checkin).
//
// Payload: { eventId }

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { eventId } = body;
    if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });

    const { authorized } = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!authorized) return Response.json({ error: 'Sem permissão para este evento.' }, { status: 403 });

    const svc = base44.asServiceRole;

    const [payments, tickets, participants] = await Promise.all([
      svc.entities.Payment.filter({ event_id: eventId, is_deleted: false }, undefined, 10000),
      svc.entities.Ticket.filter({ event_id: eventId, is_deleted: false }, undefined, 10000),
      svc.entities.Participant.filter({ event_id: eventId, is_deleted: false }, undefined, 10000),
    ]);

    const succeeded = payments.filter((p: any) => p.status === 'succeeded');
    const revenue = succeeded.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    const ticketsSold = tickets.filter((t: any) => t.status === 'issued' || t.status === 'used').length;
    const ticketsIssued = tickets.length;
    const ticketsUsed = tickets.filter((t: any) => t.status === 'used').length;
    const checkins = participants.filter((p: any) => p.checkin_status === 'confirmed').length;

    return Response.json({
      eventId,
      revenue: Math.round(revenue * 100) / 100,
      ticketsSold,
      ticketsIssued,
      ticketsUsed,
      checkins,
      ordersPaid: succeeded.length,
    });
  } catch (error: any) {
    console.error('[getEventSalesSummary]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
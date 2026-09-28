import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { scanAll } from "../../shared/completeScan.ts";

// Resumo de vendas de um evento para o gerente/admin: ingressos vendidos,
// receita total, ingressos emitidos, check-ins realizados. Agrega Payment
// (succeeded) + Ticket (issued/used) + Participant (checkin).
//
// PERF-001 (2026-09-28) — FIM da truncagem silenciosa (10000): varredura
// completa paginada por id (scanAll) com filtros movidos para a QUERY
// (payments succeeded; participants checkin confirmado). A resposta informa
// consultas executadas e completude (scan.*). Nenhum valor financeiro ou
// regra de estorno alterado.
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

    // Varredura completa — filtros na query, teto EXPLÍCITO apenas no scanAll.
    const [paymentsScan, ticketsScan, participantsScan] = await Promise.all([
      scanAll(svc.entities.Payment, { event_id: eventId, status: 'succeeded', is_deleted: false }),
      scanAll(svc.entities.Ticket, { event_id: eventId, is_deleted: false }),
      scanAll(svc.entities.Participant, { event_id: eventId, is_deleted: false, checkin_status: 'confirmed' }),
    ]);
    const payments = paymentsScan.items;
    const tickets = ticketsScan.items;
    const checkins = participantsScan.items.length;

    const revenue = payments.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    const ticketsSold = tickets.filter((t: any) => t.status === 'issued' || t.status === 'used').length;
    const ticketsIssued = tickets.length;
    const ticketsUsed = tickets.filter((t: any) => t.status === 'used').length;

    return Response.json({
      eventId,
      revenue: Math.round(revenue * 100) / 100,
      ticketsSold,
      ticketsIssued,
      ticketsUsed,
      checkins,
      ordersPaid: payments.length,
      scan: {
        payments: { records: payments.length, queries: paymentsScan.queries, complete: paymentsScan.complete },
        tickets: { records: tickets.length, queries: ticketsScan.queries, complete: ticketsScan.complete },
        participants: { records: checkins, queries: participantsScan.queries, complete: participantsScan.complete },
      },
    });
  } catch (error: any) {
    console.error('[getEventSalesSummary]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
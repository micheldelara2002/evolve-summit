import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

// Check-in de ingresso por QR (hash_code) ou ticket_id. Staff/admin/gerente.
// Marca Ticket.status='used', used_at; Participant.checkin_status='confirmed',
// checkin_at, checked_in_by_user_id. Idempotente: já 'used' retorna aviso.
// Rejeita cancelled/refunded.
//
// Payload: { code }  — hash_code do ingresso (do QR) ou ticket_id.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { code } = body;
    if (!code || typeof code !== 'string') {
      return Response.json({ error: 'Código do ingresso obrigatório.' }, { status: 400 });
    }
    const clean = code.trim();

    const svc = base44.asServiceRole;

    // Resolve por hash_code ou id (id só se for ObjectId válido).
    let tickets = await svc.entities.Ticket.filter({ hash_code: clean, is_deleted: false });
    if ((!tickets || tickets.length === 0) && /^[0-9a-f]{24}$/i.test(clean)) {
      tickets = await svc.entities.Ticket.filter({ id: clean, is_deleted: false });
    }
    const ticket = tickets?.[0];
    if (!ticket) return Response.json({ error: 'Ingresso não encontrado.', status: 'not_found' }, { status: 404 });

    // Autorização: staff/gerente do evento.
    const { authorized } = await verifyEventMembership(base44, user, ticket.event_id, EVENT_MANAGER_ROLES);
    if (!authorized && user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão para check-in neste evento.' }, { status: 403 });
    }

    if (ticket.status === 'cancelled' || ticket.status === 'refunded') {
      return Response.json({
        ok: false,
        status: ticket.status,
        holder_name: ticket.holder_name,
        message: 'Ingresso cancelado/estornado — entrada bloqueada.',
      });
    }
    if (ticket.status === 'used') {
      const part = ticket.participant_id ? (await svc.entities.Participant.filter({ id: ticket.participant_id }))[0] : null;
      return Response.json({
        ok: false,
        status: 'used',
        holder_name: ticket.holder_name,
        used_at: ticket.used_at,
        message: 'Ingresso já utilizado.',
        participant: part ? { id: part.id, checkin_status: part.checkin_status } : null,
      });
    }

    const now = new Date().toISOString();

    await svc.entities.Ticket.update(ticket.id, { status: 'used', used_at: now });

    let participant = null;
    if (ticket.participant_id) {
      participant = (await svc.entities.Participant.filter({ id: ticket.participant_id }))[0];
      if (participant && participant.checkin_status !== 'confirmed') {
        await svc.entities.Participant.update(ticket.participant_id, {
          checkin_status: 'confirmed',
          checkin_at: now,
          checked_in_by_user_id: user.id,
        });
      }
    }

    try {
      await svc.entities.AuditLog.create({
        action: 'status_change',
        entity_type: 'Ticket',
        entity_id: ticket.id,
        details: JSON.stringify({ type: 'ticket_checkin', hash_code: ticket.hash_code }),
        event_id: ticket.event_id,
        user_id: user.id,
      });
    } catch {}

    return Response.json({
      ok: true,
      status: 'used',
      holder_name: ticket.holder_name,
      ticket_type_name: ticket.ticket_type_name,
      used_at: now,
      message: 'Check-in confirmado!',
      participant: participant ? { id: participant.id } : null,
    });
  } catch (error: any) {
    console.error('[checkinTicket]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
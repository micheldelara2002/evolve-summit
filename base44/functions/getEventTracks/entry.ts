import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyAnyEventMembership } from "../../shared/eventAuth.ts";

/**
 * getEventTracks — leitura event-scoped de Tracks (Lote 2 RLS).
 *
 * Mesmo padrão arquitetural do piloto getEventRooms.
 *
 * Autorização (não baseada somente em User.role):
 *   - admin → acesso global (ainda assim só Tracks do eventId solicitado).
 *   - não-admin → EventMembership ativa no evento OU Participant ativo no evento.
 *
 * Regras:
 *   - eventId obrigatório.
 *   - nunca expõe Tracks de outros eventos.
 *   - registros soft-deleted nunca retornados.
 *   - service role usado apenas dentro desta função.
 *   - preserva todos os campos existentes da Track.
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { eventId } = await req.json();
    if (!eventId || typeof eventId !== 'string') {
      return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });
    }

    const svc = base44.asServiceRole;

    let authorized = user.role === 'admin';

    // EventMembership ativa no evento (qualquer papel) — fonte de permissão.
    if (!authorized) {
      const membership = await verifyAnyEventMembership(base44, user, eventId);
      authorized = membership.authorized;
    }

    // Participant ativo no evento — attendees não possuem EventMembership;
    // a inscrição válida no evento autoriza a leitura das trilhas (agenda).
    if (!authorized) {
      let personId = user.person_id || null;
      if (!personId && user.email) {
        const persons = await svc.entities.Person.filter({ contact_email: user.email, is_active: true });
        personId = persons?.[0]?.id || null;
      }
      const parts = await svc.entities.Participant.filter({ event_id: eventId, is_deleted: false });
      const match = parts.find(
        (p) =>
          p.registration_status !== 'cancelled' &&
          ((personId && p.person_id === personId) || (user.email && p.email === user.email))
      );
      authorized = !!match;
    }

    if (!authorized) {
      return Response.json({ error: 'Sem permissão para acessar trilhas deste evento.' }, { status: 403 });
    }

    const tracks = await svc.entities.Track.filter({ event_id: eventId, is_deleted: false });
    return Response.json({ tracks });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
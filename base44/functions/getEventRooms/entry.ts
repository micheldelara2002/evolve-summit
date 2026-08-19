import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyAnyEventMembership } from "../../shared/eventAuth.ts";

/**
 * getEventRooms — leitura event-scoped de Rooms (piloto RLS).
 *
 * Arquitetura:
 *   usuário autenticado → resolve Person → valida vínculo ativo no evento
 *   (EventMembership ativa OU Participant ativo — attendees não têm
 *   EventMembership) → consulta Room via service role → retorna somente
 *   as Rooms do eventId autorizado.
 *
 * Regras:
 *   - admin: acesso global (ainda assim só Rooms do eventId solicitado).
 *   - não-admin: precisa de EventMembership ativa (qualquer papel) OU
 *     Participant ativo (presença/credenciamento) no evento.
 *   - nunca expõe Rooms de outros eventos.
 *   - service role usado apenas dentro desta função.
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { eventId } = await req.json();
    if (!eventId) return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });

    const svc = base44.asServiceRole;

    let authorized = user.role === 'admin';

    // EventMembership ativa no evento (qualquer papel) — fonte de permissão.
    if (!authorized) {
      const membership = await verifyAnyEventMembership(base44, user, eventId);
      authorized = membership.authorized;
    }

    // Participant ativo no evento — attendees não possuem EventMembership;
    // a presença/inscrição válida no evento autoriza a leitura das salas
    // (mantém o comportamento atual do participante na agenda).
    if (!authorized) {
      let personId = user.person_id || null;
      if (!personId && user.email) {
        const persons = await svc.entities.Person.filter({ contact_email: user.email, is_active: true });
        personId = persons?.[0]?.id || null;
      }
      const parts = await svc.entities.Participant.filter({ event_id: eventId, is_deleted: false });
      const match = parts.find((p) =>
        p.registration_status !== 'cancelled' &&
        ((personId && p.person_id === personId) || (user.email && p.email === user.email))
      );
      authorized = !!match;
    }

    if (!authorized) {
      return Response.json({ error: 'Sem permissão para acessar salas deste evento.' }, { status: 403 });
    }

    const rooms = await svc.entities.Room.filter({ event_id: eventId, is_deleted: false });
    return Response.json({ rooms });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

/**
 * getEventSessions — leitura event-scoped de Sessions (Lote 2 RLS).
 *
 * Aceita múltiplos eventIds (consumidores cross-event: SpeakerKPIs,
 * SpeakerRankingView, PartnerDashboard) mas valida CADA evento
 * independentemente. Retorna somente Sessions dos eventos autorizados.
 *
 * Autorização (não baseada somente em User.role):
 *   - admin → autorizado para qualquer evento informado.
 *   - não-admin → EventMembership ativa no evento OU Participant ativo no evento.
 *
 * Regras:
 *   - eventIds obrigatório (array não vazio).
 *   - um usuário autorizado em A e não em B jamais recebe Sessions de B.
 *   - Sessions soft-deleted (is_deleted === true) nunca retornadas.
 *   - service role usado apenas dentro desta função.
 *   - preserva todos os campos existentes da Session.
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { eventIds } = body;
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return Response.json({ error: 'eventIds é obrigatório (array não vazio).' }, { status: 400 });
    }
    // Dedupe + sanitiza ids inválidos.
    const uniqueIds = [
      ...new Set(
        eventIds
          .map((id) => (typeof id === 'string' ? id.trim() : ''))
          .filter((id) => id.length > 0)
      ),
    ];
    if (!uniqueIds.length) {
      return Response.json({ error: 'eventIds inválido.' }, { status: 400 });
    }

    const svc = base44.asServiceRole;

    // Resolve person_id do caller uma única vez (Participant matching por person/email).
    let personId = user.person_id || null;
    if (!personId && user.email) {
      const persons = await svc.entities.Person.filter({ contact_email: user.email, is_active: true });
      personId = persons?.[0]?.id || null;
    }

    let authorizedIds: string[];
    if (user.role === 'admin') {
      authorizedIds = uniqueIds;
    } else {
      // EventMembership ativa em qualquer um dos eventos — consulta única batched.
      const memberships = await svc.entities.EventMembership.filter({
        event_id: { $in: uniqueIds },
        user_id: user.id,
        is_active: true,
        is_deleted: false,
      });
      const membershipEventIds = new Set(memberships.map((m) => m.event_id));

      // Participant ativo nos eventos — consulta única batched, match por person/email.
      const participants = await svc.entities.Participant.filter({
        event_id: { $in: uniqueIds },
        is_deleted: false,
      });
      const participantEventIds = new Set(
        participants
          .filter(
            (p) =>
              p.registration_status !== 'cancelled' &&
              ((personId && p.person_id === personId) || (user.email && p.email === user.email))
          )
          .map((p) => p.event_id)
      );

      const authorizedSet = new Set<string>([...membershipEventIds, ...participantEventIds]);
      authorizedIds = uniqueIds.filter((id) => authorizedSet.has(id));
    }

    if (!authorizedIds.length) {
      return Response.json(
        { error: 'Sem permissão para acessar sessões dos eventos informados.' },
        { status: 403 }
      );
    }

    const sessions = await svc.entities.Session.filter({
      event_id: { $in: authorizedIds },
      is_deleted: false,
    });

    return Response.json({ sessions });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
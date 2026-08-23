import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveCallerPerson } from "../../shared/sessionAuth.ts";

/**
 * getSpeakerQuestionStats — contagens agregadas de perguntas por sessão (KPIs do
 * palestrante). Lote RLS Session Interaction.
 *
 * Substitui o acesso SDK direto a SessionQuestion nos consumidores cross-session
 * (SpeakerKPIs, SpeakerEventCard), que precisam somente de total/answered por sessão.
 *
 * Autorização: para cada session_id informado, retorna stats somente se o caller for
 *   admin OU speaker dono daquela Session (Participant.id === Session.speaker_id).
 *   Sessões não autorizadas são silenciosamente omitidas (sem vazar existência).
 *
 * Retorna: { stats: [{ session_id, total, answered }] } somente para sessões autorizadas.
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { sessionIds } = body;
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return Response.json({ error: 'sessionIds é obrigatório (array não vazio).' }, { status: 400 });
    }
    const uniqueIds = [...new Set(sessionIds.filter((id: any) => typeof id === 'string' && id.trim().length > 0))];
    if (!uniqueIds.length) return Response.json({ error: 'sessionIds inválido.' }, { status: 400 });

    const svc = base44.asServiceRole;
    const sessions = await svc.entities.Session.filter({ id: { $in: uniqueIds }, is_deleted: false });

    let authorizedIds: string[];
    if (user.role === 'admin') {
      authorizedIds = sessions.map((s: any) => s.id);
    } else {
      const personId = await resolveCallerPerson(svc, user);
      const eventIds = [...new Set(sessions.map((s: any) => s.event_id))];
      const parts = await svc.entities.Participant.filter({ event_id: { $in: eventIds }, is_deleted: false });
      const mySpeakerParticipantIds = new Set(
        parts
          .filter(
            (p: any) =>
              p.registration_status !== 'cancelled' &&
              ((personId && p.person_id === personId) || (user.email && p.email === user.email))
          )
          .map((p: any) => p.id)
      );
      authorizedIds = sessions
        .filter((s: any) => s.speaker_id && mySpeakerParticipantIds.has(s.speaker_id))
        .map((s: any) => s.id);
    }

    if (!authorizedIds.length) return Response.json({ stats: [] });

    const questions = await svc.entities.SessionQuestion.filter({ session_id: { $in: authorizedIds }, is_deleted: false });
    const stats = authorizedIds.map((sid) => {
      const qs = questions.filter((q: any) => q.session_id === sid);
      return { session_id: sid, total: qs.length, answered: qs.filter((q: any) => q.is_answered).length };
    });

    return Response.json({ stats });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
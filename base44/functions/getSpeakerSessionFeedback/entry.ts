// getSpeakerSessionFeedback — Lote 4. Leitura de avaliações (SessionReview) e
// presenças (SessionAttendance) DAS PRÓPRIAS sessões do palestrante. IDs
// malformados são descartados (idGuard). Não-admin só recebe sessões onde é o
// speaker (Session.speaker_id → Participant vinculado por person_id/email).
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { resolveUserPersonId } from '../../shared/eventAuth.ts';
import { validIds } from '../../shared/idGuard.ts';

const MAX_SESSIONS = 50;

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Não autenticado.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const sessionIds = validIds(body.sessionIds).slice(0, MAX_SESSIONS);
    if (!sessionIds.length) {
      return Response.json({ sessionIds: [], reviews: [], attendances: [] });
    }

    const svc = base44.asServiceRole;
    const sessions = await svc.entities.Session.filter({ id: { $in: sessionIds }, is_deleted: false });

    let allowed = sessions.map((s) => s.id);
    if (user.role !== 'admin') {
      const callerPersonId = await resolveUserPersonId(base44, user);
      const speakerIds = [...new Set(sessions.map((s) => s.speaker_id).filter(Boolean))];
      let speakerParticipants = [];
      if (speakerIds.length) {
        speakerParticipants = await svc.entities.Participant.filter({
          id: { $in: speakerIds },
          is_deleted: false,
        });
      }
      const mine = new Set(
        speakerParticipants
          .filter((p) =>
            (p.email && user.email && p.email.toLowerCase() === user.email.toLowerCase()) ||
            (p.person_id && callerPersonId && p.person_id === callerPersonId)
          )
          .map((p) => p.id)
      );
      allowed = sessions.filter((s) => mine.has(s.speaker_id)).map((s) => s.id);
    }

    if (!allowed.length) {
      return Response.json({ sessionIds: [], reviews: [], attendances: [] });
    }

    const [reviews, attendances] = await Promise.all([
      svc.entities.SessionReview.filter({ session_id: { $in: allowed } }),
      svc.entities.SessionAttendance.filter({ session_id: { $in: allowed } }),
    ]);

    return Response.json({ sessionIds: allowed, reviews, attendances });
  } catch (error) {
    console.error('getSpeakerSessionFeedback error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
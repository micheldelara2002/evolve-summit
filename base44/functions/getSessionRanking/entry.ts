// =============================================================================
// getSessionRanking — P0 (2026-09-29)
// Ranking de Palestras para a GESTÃO do evento: avaliações (SessionReview) e
// presenças (SessionAttendance) são RLS admin-only — antes o frontend lia
// direto do SDK e gerentes/staff viam "sem dados" mesmo com dados no evento.
//
// REGRA DE NEGÓCIO (aprovada 2026-09-29):
//   - Admin: vê tudo de tudo.
//   - Gerente/equipe: veem todas as avaliações dos eventos deles
//     (EventMembership manager/team do PRÓPRIO evento — verifyEventMembership).
//   - Palestrante: vê apenas as avaliações das PRÓPRIAS sessões, mesmo em
//     eventos distintos — fluxo já coberto por getSpeakerSessionFeedback
//     (posse validada server-side por Session.speaker_id → Participant).
// =============================================================================
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from '../../shared/accountSecurity.ts';
import { verifyEventMembership, EVENT_MANAGER_ROLES } from '../../shared/eventAuth.ts';
import { scanAll } from '../../shared/completeScan.ts';

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { eventId } = await req.json().catch(() => ({}));
    if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });

    const auth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!auth.authorized) {
      return Response.json({ error: 'Sem permissão para ver o ranking deste evento.' }, { status: 403 });
    }

    const svc = base44.asServiceRole;
    const [reviewsRes, attendancesRes] = await Promise.all([
      scanAll(svc.entities.SessionReview, { event_id: eventId }),
      scanAll(svc.entities.SessionAttendance, { event_id: eventId }),
    ]);

    return Response.json({
      reviews: reviewsRes.items,
      attendances: attendancesRes.items,
      complete: reviewsRes.complete && attendancesRes.complete,
    });
  } catch (error) {
    console.error('getSessionRanking error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
// saveSessionReview — Lote 4. Avaliação de sessão movida para o servidor.
//   action='get'  → retorna a própria avaliação do chamador na sessão
//   action='save' → upsert (uma avaliação por participante por sessão)
// Autorização: participante ativo do evento da sessão (resolvido server-side,
// nunca confia no participantId do cliente), admin ou gestor do evento.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { resolveSessionCaller } from '../../shared/sessionAuth.ts';
import { verifyEventMembership, EVENT_MANAGER_ROLES } from '../../shared/eventAuth.ts';
import { isValidId } from '../../shared/idGuard.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Não autenticado.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const sessionId = body.sessionId;
    const action = String(body.action || '');
    if (!isValidId(sessionId)) {
      return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
    }
    if (!['get', 'save'].includes(action)) {
      return Response.json({ error: 'Ação inválida.' }, { status: 400 });
    }

    const svc = base44.asServiceRole;
    const ctx = await resolveSessionCaller(svc, user, sessionId);
    if (!ctx) return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });

    const { session, participant, isAdmin } = ctx;
    if (!isAdmin && !participant) {
      const { authorized } = await verifyEventMembership(base44, user, session.event_id, EVENT_MANAGER_ROLES);
      if (!authorized) {
        return Response.json({ error: 'Sem permissão para avaliar esta sessão.' }, { status: 403 });
      }
    }

    const myParticipantId = participant?.id || null;
    const existing = myParticipantId
      ? ((await svc.entities.SessionReview.filter({
          session_id: sessionId,
          participant_id: myParticipantId,
        })) || [])[0] || null
      : null;

    if (action === 'get') {
      return Response.json({ review: existing });
    }

    // save
    const rating = Number(body.rating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
      return Response.json({ error: 'Nota inválida (0-10).' }, { status: 400 });
    }
    if (!myParticipantId) {
      return Response.json({ error: 'Avaliação exige participante ativo no evento.' }, { status: 403 });
    }
    const comment =
      typeof body.comment === 'string' && body.comment.trim()
        ? body.comment.trim().slice(0, 1000)
        : null;

    if (existing) {
      const review = await svc.entities.SessionReview.update(existing.id, { rating, comment });
      return Response.json({ review });
    }
    const review = await svc.entities.SessionReview.create({
      event_id: session.event_id,
      session_id: sessionId,
      participant_id: myParticipantId,
      rating,
      comment,
    });
    return Response.json({ review });
  } catch (error) {
    console.error('saveSessionReview error:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
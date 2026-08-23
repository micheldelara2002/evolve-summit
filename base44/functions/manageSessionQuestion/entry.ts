import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveSessionCaller } from "../../shared/sessionAuth.ts";

/**
 * manageSessionQuestion — criação e marcação de respondida de perguntas
 * (Lote RLS Session Interaction).
 *
 * Substitui o acesso SDK direto a SessionQuestion.
 *
 * Operações: create | markAnswered
 *   - create:      { sessionId, data: { question, visibility } } → participante autorizado cria.
 *   - markAnswered: { questionId, data?: { isAnswered } }        → speaker/admin alterna is_answered.
 *
 * Autorização:
 *   - create → admin OU participante ativo no evento. participant_id/person_id são
 *     DERIVADOS do caller (nunca do cliente).
 *   - markAnswered → admin OU speaker dono da Session ( Participant.id === Session.speaker_id).
 *     Um participante NÃO pode marcar a pergunta de outra pessoa.
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { operation, questionId, sessionId, data } = body;
    const svc = base44.asServiceRole;

    if (!operation || typeof operation !== 'string') {
      return Response.json({ error: 'operation é obrigatório.' }, { status: 400 });
    }

    if (operation === 'create') {
      if (!sessionId) return Response.json({ error: 'sessionId é obrigatório.' }, { status: 400 });
      if (!data?.question || !String(data.question).trim()) {
        return Response.json({ error: 'Pergunta vazia.' }, { status: 400 });
      }
      const ctx = await resolveSessionCaller(svc, user, sessionId);
      if (!ctx) return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
      if (!ctx.isAdmin && !ctx.isAuthorizedParticipant) {
        return Response.json({ error: 'Somente participantes autorizados podem perguntar.' }, { status: 403 });
      }
      const created = await svc.entities.SessionQuestion.create({
        event_id: ctx.session.event_id,
        session_id: sessionId,
        participant_id: ctx.participant?.id || null,
        person_id: ctx.participant?.person_id || ctx.personId || null,
        question: String(data.question).trim(),
        visibility: data?.visibility === 'particular' ? 'particular' : 'publica',
      });
      return Response.json({ question: created });
    }

    if (operation === 'markAnswered') {
      if (!questionId) return Response.json({ error: 'questionId é obrigatório.' }, { status: 400 });
      const questions = await svc.entities.SessionQuestion.filter({ id: questionId, is_deleted: false });
      const question = questions?.[0];
      if (!question) return Response.json({ error: 'Pergunta não encontrada.' }, { status: 404 });
      const ctx = await resolveSessionCaller(svc, user, question.session_id);
      if (!ctx) return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
      if (!ctx.isAdmin && !ctx.isSpeaker) {
        return Response.json({ error: 'Somente o palestrante pode marcar perguntas como respondidas.' }, { status: 403 });
      }
      const nextVal = typeof data?.isAnswered === 'boolean' ? data.isAnswered : !question.is_answered;
      await svc.entities.SessionQuestion.update(questionId, { is_answered: nextVal });
      return Response.json({ ok: true, is_answered: nextVal });
    }

    return Response.json({ error: 'Operação inválida.' }, { status: 400 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
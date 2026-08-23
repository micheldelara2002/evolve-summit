import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveSessionCaller } from "../../shared/sessionAuth.ts";

/**
 * manageSessionAnswer — respostas do palestrante a perguntas
 * (Lote RLS Session Interaction).
 *
 * Substitui o acesso SDK direto a SessionAnswer.
 *
 * Operações: save | delete  (save cobre create e update — upsert idempotente)
 *   - save:   { questionId, answerText } → cria ou atualiza a resposta do palestrante
 *             para a pergunta e marca a pergunta como is_answered=true.
 *   - delete: { questionId }             → soft-delete da resposta.
 *
 * Autorização: admin OU speaker dono da Session (Participant.id === Session.speaker_id).
 *   speaker_participant_id / speaker_person_id são DERIVADOS do caller (nunca do cliente).
 *   A Session é resolvida a partir da pergunta (question_id) e a ownership revalidada.
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { operation, questionId, answerText } = body;
    const svc = base44.asServiceRole;

    if (!operation || typeof operation !== 'string') {
      return Response.json({ error: 'operation é obrigatório.' }, { status: 400 });
    }
    if (!questionId) return Response.json({ error: 'questionId é obrigatório.' }, { status: 400 });

    const questions = await svc.entities.SessionQuestion.filter({ id: questionId, is_deleted: false });
    const question = questions?.[0];
    if (!question) return Response.json({ error: 'Pergunta não encontrada.' }, { status: 404 });

    const ctx = await resolveSessionCaller(svc, user, question.session_id);
    if (!ctx) return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
    if (!ctx.isAdmin && !ctx.isSpeaker) {
      return Response.json({ error: 'Somente o palestrante pode responder perguntas.' }, { status: 403 });
    }

    if (operation === 'save') {
      const text = typeof answerText === 'string' ? answerText.trim() : '';
      if (!text) return Response.json({ error: 'Resposta vazia.' }, { status: 400 });
      const existing = await svc.entities.SessionAnswer.filter({ question_id: questionId, is_deleted: false });
      const ans = existing?.[0];
      if (ans) {
        await svc.entities.SessionAnswer.update(ans.id, { answer_text: text });
      } else {
        await svc.entities.SessionAnswer.create({
          question_id: questionId,
          session_id: question.session_id,
          event_id: question.event_id,
          speaker_participant_id: ctx.participant?.id || null,
          speaker_person_id: ctx.participant?.person_id || ctx.personId || null,
          answer_text: text,
        });
      }
      await svc.entities.SessionQuestion.update(questionId, { is_answered: true });
      return Response.json({ ok: true });
    }

    if (operation === 'delete') {
      const existing = await svc.entities.SessionAnswer.filter({ question_id: questionId, is_deleted: false });
      if (existing?.[0]) await svc.entities.SessionAnswer.update(existing[0].id, { is_deleted: true });
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Operação inválida.' }, { status: 400 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
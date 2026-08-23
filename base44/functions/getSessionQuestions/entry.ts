import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveSessionCaller } from "../../shared/sessionAuth.ts";

/**
 * getSessionQuestions — leitura autorizada de perguntas + respostas de uma sessão
 * (Lote RLS Session Interaction).
 *
 * Substitui o acesso SDK direto a SessionQuestion / SessionAnswer.
 *
 * Autorização:
 *   - admin → vê todas.
 *   - speaker dono da Session → vê todas (publica + particular).
 *   - participante ativo no evento → vê publica + suas próprias particular.
 *
 * Visibility (preservada do modelo existente):
 *   - publica → participantes autorizados + speaker/admin.
 *   - particular → somente speaker/admin + o próprio autor.
 *
 * Respostas (SessionAnswer) são retornadas aninhadas por pergunta, somente para
 * perguntas visíveis ao caller. Não há exposição cruzada de perguntas particulares.
 *
 * Para participantes, participant_id/person_id das perguntas são omitidos (não são
 * necessários após a filtragem server-side e evitam vazar autoria alheia).
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { sessionId } = body;
    if (!sessionId || typeof sessionId !== 'string') {
      return Response.json({ error: 'sessionId é obrigatório.' }, { status: 400 });
    }

    const svc = base44.asServiceRole;
    const ctx = await resolveSessionCaller(svc, user, sessionId);
    if (!ctx) return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
    const { isAdmin, isSpeaker, isAuthorizedParticipant, participant } = ctx;

    if (!isAdmin && !isSpeaker && !isAuthorizedParticipant) {
      return Response.json({ error: 'Sem permissão para acessar esta sessão.' }, { status: 403 });
    }

    const questions = await svc.entities.SessionQuestion.filter({ session_id: sessionId, is_deleted: false });
    const answers = await svc.entities.SessionAnswer.filter({ session_id: sessionId, is_deleted: false });
    const answerByQ: Record<string, any> = {};
    for (const a of answers) answerByQ[a.question_id] = a;

    const myParticipantId = participant?.id || null;
    const canSeeAll = isAdmin || isSpeaker;

    const result = questions
      .filter((q: any) => {
        if (canSeeAll) return true;
        if (q.visibility === 'publica') return true;
        return !!(myParticipantId && q.participant_id === myParticipantId);
      })
      .map((q: any) => {
        const ans = answerByQ[q.id];
        const base: any = {
          id: q.id,
          event_id: q.event_id,
          session_id: q.session_id,
          question: q.question,
          visibility: q.visibility,
          is_answered: q.is_answered,
          upvotes: q.upvotes,
          answer: ans ? { id: ans.id, answer_text: ans.answer_text } : null,
        };
        // speaker/admin recebem autoria (para gestão); participantes não recebem.
        if (canSeeAll) {
          base.participant_id = q.participant_id;
          base.person_id = q.person_id;
        }
        return base;
      });

    return Response.json({ questions: result });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
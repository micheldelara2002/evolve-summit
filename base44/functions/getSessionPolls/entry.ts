import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveSessionCaller } from "../../shared/sessionAuth.ts";

/**
 * getSessionPolls — leitura autorizada de enquetes de uma sessão (Lote RLS Session Interaction).
 *
 * Retorna polls + opções + contagens agregadas + (para participante) minha resposta.
 * Substitui o acesso SDK direto a SessionPoll / SessionPollOption / SessionPollAnswer.
 *
 * Autorização (não baseada somente em User.role):
 *   - admin → autorizado.
 *   - speaker dono da Session (Participant.id === Session.speaker_id) → autorizado, vê todos os status.
 *   - participante ativo no evento → autorizado, vê apenas polls live/closed (não draft).
 *
 * Efeitos colaterais autorizados: encerra (closed) polls live cujo live_ends_at já passou,
 *   para que o estado lido seja consistente (mesma regra já existia no submitPollAnswer).
 *
 * Realtime: a subscription direta em SessionPollAnswer deixa de ser segura após o RLS;
 *   o consumidor deve usar refetchInterval sobre este endpoint (mecanismo autorizado equivalente).
 *
 * Nunca expõe respostas individuais de outros participantes — somente contagens agregadas
 * e a própria resposta do caller (myAnswer).
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
    const { isAdmin, isSpeaker, isAuthorizedParticipant, personId } = ctx;

    if (!isAdmin && !isSpeaker && !isAuthorizedParticipant) {
      return Response.json({ error: 'Sem permissão para acessar esta sessão.' }, { status: 403 });
    }

    const polls = await svc.entities.SessionPoll.filter({ session_id: sessionId, is_deleted: false });

    // Auto-encerrar polls live expiradas (estado consistente, lado server).
    const now = new Date();
    for (const p of polls) {
      if (p.status === 'live' && p.live_ends_at && new Date(p.live_ends_at) < now) {
        await svc.entities.SessionPoll.update(p.id, { status: 'closed', closed_at: now.toISOString() });
        p.status = 'closed';
      }
    }

    // Participante vê apenas live/closed; speaker/admin veem todos.
    const visiblePolls = (isSpeaker || isAdmin) ? polls : polls.filter((p: any) => p.status !== 'draft');
    if (!visiblePolls.length) return Response.json({ polls: [] });

    const pollIds = visiblePolls.map((p: any) => p.id);
    const allOptions = await svc.entities.SessionPollOption.filter({ poll_id: { $in: pollIds }, is_deleted: false });
    const allAnswers = await svc.entities.SessionPollAnswer.filter({ poll_id: { $in: pollIds }, is_deleted: false });

    // Agregação por poll/opção + minha resposta.
    const countsByPoll: Record<string, Record<string, number>> = {};
    const votersByPoll: Record<string, number> = {};
    const myAnswerByPoll: Record<string, { id: string; selected_option_ids: string[] }> = {};

    for (const a of allAnswers) {
      votersByPoll[a.poll_id] = (votersByPoll[a.poll_id] || 0) + 1;
      let ids: string[] = [];
      try { ids = JSON.parse(a.selected_option_ids || '[]'); } catch { ids = []; }
      if (personId && a.person_id === personId) {
        myAnswerByPoll[a.poll_id] = { id: a.id, selected_option_ids: ids };
      }
      for (const id of ids) {
        countsByPoll[a.poll_id] = countsByPoll[a.poll_id] || {};
        countsByPoll[a.poll_id][id] = (countsByPoll[a.poll_id][id] || 0) + 1;
      }
    }

    const optionsByPoll: Record<string, any[]> = {};
    for (const o of allOptions) {
      optionsByPoll[o.poll_id] = optionsByPoll[o.poll_id] || [];
      optionsByPoll[o.poll_id].push({
        id: o.id,
        option_text: o.option_text,
        position: o.position,
        count: (countsByPoll[o.poll_id] && countsByPoll[o.poll_id][o.id]) || 0,
      });
    }

    const result = visiblePolls.map((p: any) => {
      const opts = (optionsByPoll[p.id] || []).sort((a: any, b: any) => a.position - b.position);
      const totalVotes = opts.reduce((s: number, o: any) => s + o.count, 0);
      return {
        id: p.id,
        event_id: p.event_id,
        session_id: p.session_id,
        created_by_person_id: p.created_by_person_id,
        question: p.question,
        answer_type: p.answer_type,
        max_options: p.max_options,
        duration_seconds: p.duration_seconds,
        status: p.status,
        live_started_at: p.live_started_at,
        live_ends_at: p.live_ends_at,
        closed_at: p.closed_at,
        options: opts,
        totalVoters: votersByPoll[p.id] || 0,
        totalVotes,
        myAnswer: myAnswerByPoll[p.id] || null,
      };
    });

    return Response.json({ polls: result });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveSessionCaller } from "../../shared/sessionAuth.ts";

/**
 * manageSessionPoll — cria/edição/exclusão/abertura/encerramento de enquetes + opções
 * (Lote RLS Session Interaction).
 *
 * Substitui o acesso SDK direto (create/update/delete/open/close) a SessionPoll e
 * SessionPollOption no painel do palestrante.
 *
 * Operações: create | update | delete | open | close
 *   - create:  { sessionId, data, options }  → cria poll draft + opções.
 *   - update:  { pollId, data, options }    → edita poll + substitui opções (soft-delete + recria).
 *   - delete:  { pollId }                    → soft-delete.
 *   - open:    { pollId }                    → status=live + live_ends_at.
 *   - close:   { pollId }                    → status=closed.
 *
 * Autorização: admin OU speaker dono da Session (Participant.id === Session.speaker_id).
 *   - created_by_person_id é DERIVADO do caller (nunca confiado do cliente).
 *   - Em update/open/close/delete, a Session é resolvida a partir do pollId e a
 *     ownership revalidada server-side (não confia no pollId isoladamente).
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { operation, pollId, sessionId, data, options } = body;
    const svc = base44.asServiceRole;

    if (!operation || typeof operation !== 'string') {
      return Response.json({ error: 'operation é obrigatório.' }, { status: 400 });
    }

    // create resolve a Session a partir do sessionId.
    if (operation === 'create') {
      if (!sessionId) return Response.json({ error: 'sessionId é obrigatório.' }, { status: 400 });
      const ctx = await resolveSessionCaller(svc, user, sessionId);
      if (!ctx) return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
      if (!ctx.isAdmin && !ctx.isSpeaker) {
        return Response.json({ error: 'Somente o palestrante pode criar enquetes.' }, { status: 403 });
      }
      const created = await svc.entities.SessionPoll.create({
        event_id: ctx.session.event_id,
        session_id: sessionId,
        created_by_person_id: ctx.participant?.person_id || ctx.personId || null,
        question: data?.question,
        answer_type: data?.answer_type || 'single_choice',
        max_options: data?.max_options ?? 1,
        duration_seconds: data?.duration_seconds ?? 15,
        status: 'draft',
      });
      if (Array.isArray(options)) {
        const clean = options.map((t: any, i: number) => ({ poll_id: created.id, option_text: String(t), position: i })).filter((o: any) => o.option_text);
        if (clean.length) await svc.entities.SessionPollOption.bulkCreate(clean);
      }
      return Response.json({ poll: created });
    }

    // Demais operações resolvem a Session a partir do pollId.
    if (!pollId) return Response.json({ error: 'pollId é obrigatório.' }, { status: 400 });
    const polls = await svc.entities.SessionPoll.filter({ id: pollId, is_deleted: false });
    const poll = polls?.[0];
    if (!poll) return Response.json({ error: 'Enquete não encontrada.' }, { status: 404 });

    const ctx = await resolveSessionCaller(svc, user, poll.session_id);
    if (!ctx) return Response.json({ error: 'Sessão não encontrada.' }, { status: 404 });
    if (!ctx.isAdmin && !ctx.isSpeaker) {
      return Response.json({ error: 'Somente o palestrante pode administrar esta enquete.' }, { status: 403 });
    }

    if (operation === 'update') {
      await svc.entities.SessionPoll.update(pollId, {
        question: data?.question,
        answer_type: data?.answer_type,
        max_options: data?.max_options,
        duration_seconds: data?.duration_seconds,
      });
      if (Array.isArray(options)) {
        const oldOpts = await svc.entities.SessionPollOption.filter({ poll_id: pollId, is_deleted: false });
        if (oldOpts.length) await svc.entities.SessionPollOption.bulkUpdate(oldOpts.map((o: any) => ({ id: o.id, is_deleted: true })));
        const clean = options.map((t: any, i: number) => ({ poll_id: pollId, option_text: String(t), position: i })).filter((o: any) => o.option_text);
        if (clean.length) await svc.entities.SessionPollOption.bulkCreate(clean);
      }
      return Response.json({ ok: true });
    }

    if (operation === 'delete') {
      await svc.entities.SessionPoll.update(pollId, { is_deleted: true });
      return Response.json({ ok: true });
    }

    if (operation === 'open') {
      const now = new Date();
      const secs = poll.duration_seconds || 15;
      await svc.entities.SessionPoll.update(pollId, {
        status: 'live',
        live_started_at: now.toISOString(),
        live_ends_at: new Date(now.getTime() + secs * 1000).toISOString(),
      });
      return Response.json({ ok: true });
    }

    if (operation === 'close') {
      await svc.entities.SessionPoll.update(pollId, { status: 'closed', closed_at: new Date().toISOString() });
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Operação inválida.' }, { status: 400 });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
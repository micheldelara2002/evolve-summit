import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { verifyEventMembership, EVENT_CURATOR_ROLES } from "../../shared/eventAuth.ts";
import { incUniqueParticipant, incParticipantsByRole, moveParticipantsByRole } from "../../shared/businessMetrics.ts";

/**
 * Gerencia o ciclo de vida de uma Submission (Call for Papers).
 * - approve: cria/reativa Participant (role speaker) + cria Session vinculada (vínculo bilateral).
 * - reject/waitlist/cancel: atualiza status e, se existir Session vinculada, a desativa (integridade bilateral).
 *
 * Regras de integridade:
 *  - Participant é reutilizado (busca por email ou person_id no evento) — sem duplicidade.
 *  - A Session carrega submission_id; ao cancelar/reprovar, a Session é soft-deletada.
 *  - Idempotente: aprovar uma submission já aprovada apenas retorna a session existente.
 *
 * P0.2: Autorização event-scoped — admin global OU EventMembership{role:curator} no evento da CFP.
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { submission_id, action, review_notes } = body || {};
    if (!submission_id || !action) {
      return Response.json({ error: 'submission_id e action são obrigatórios' }, { status: 400 });
    }
    if (!['approve', 'reject', 'waitlist', 'cancel'].includes(action)) {
      return Response.json({ error: 'action inválido' }, { status: 400 });
    }

    const svc = base44.asServiceRole;
    const subs = await svc.entities.Submission.filter({ id: submission_id, is_deleted: false });
    const submission = subs[0];
    if (!submission) return Response.json({ error: 'Submission não encontrada' }, { status: 404 });

    const cfpList = await svc.entities.CallForPapers.filter({ id: submission.call_for_papers_id });
    const cfp = cfpList[0];
    if (!cfp) return Response.json({ error: 'CallForPapers não encontrada' }, { status: 404 });
    const eventId = cfp.event_id;

    // P0.2: Event-scoped authorization — admin or event-scoped curator
    const subAuth = await verifyEventMembership(base44, user, eventId, EVENT_CURATOR_ROLES);
    if (!subAuth.authorized) {
      return Response.json({ error: 'Forbidden — sem permissão de curadoria neste evento' }, { status: 403 });
    }

    const reviewer = {
      reviewer_id: user.id,
      reviewer_name: user.full_name || user.email,
    };

    if (action === 'approve') {
      // Idempotente
      if (submission.status === 'approved' && submission.session_id) {
        return Response.json({ ok: true, message: 'Já aprovada', session_id: submission.session_id });
      }

      // Encontra ou cria Participant no evento (sem duplicidade)
      let found = await svc.entities.Participant.filter({
        event_id: eventId,
        email: submission.submitter_email,
        is_deleted: false,
      });
      let participant = found[0];
      if (!participant && submission.person_id) {
        found = await svc.entities.Participant.filter({
          event_id: eventId,
          person_id: submission.person_id,
          is_deleted: false,
        });
        participant = found[0];
      }
      if (!participant) {
        participant = await svc.entities.Participant.create({
          event_id: eventId,
          full_name: submission.submitter_name,
          email: submission.submitter_email,
          person_id: submission.person_id,
          role_in_event: 'speaker',
          registration_status: 'registered',
          created_day: new Date().toISOString().slice(0, 10),
        });
        // P0.3 — mantém EventStats + MetricBucket do dashboard (unique + participants_by_role)
        await incUniqueParticipant(svc, eventId, participant.created_date);
        await incParticipantsByRole(svc, eventId, 'speaker', participant.created_date);
      } else if (participant.role_in_event !== 'speaker') {
        const oldRole = participant.role_in_event;
        await svc.entities.Participant.update(participant.id, { role_in_event: 'speaker' });
        // P0.3 — move o bucket participants_by_role do papel antigo para speaker (unique não muda)
        await moveParticipantsByRole(svc, eventId, oldRole, 'speaker', participant.created_date);
      }

      // Cria Session vinculada à submission (status "aprovada mas a completar")
      const session = await svc.entities.Session.create({
        event_id: eventId,
        title: submission.title,
        description: submission.summary,
        speaker_id: participant.id,
        speaker_name: submission.submitter_name,
        session_type: submission.proposed_type || 'palestra',
        submission_id: submission.id,
      });

      await svc.entities.Submission.update(submission.id, {
        status: 'approved',
        session_id: session.id,
        participant_id: participant.id,
        review_notes: review_notes || '',
        ...reviewer,
      });

      return Response.json({ ok: true, session_id: session.id, participant_id: participant.id });
    }

    // reject / waitlist / cancel — integridade bilateral
    if (submission.session_id) {
      const sessList = await svc.entities.Session.filter({ id: submission.session_id });
      const existing = sessList[0];
      if (existing && !existing.is_deleted) {
        await svc.entities.Session.update(existing.id, { is_deleted: true });
      }
    }

    const nextStatus = action === 'reject' ? 'rejected' : action === 'waitlist' ? 'waitlist' : 'cancelled';
    await svc.entities.Submission.update(submission.id, {
      status: nextStatus,
      review_notes: review_notes || '',
      ...reviewer,
    });

    return Response.json({ ok: true, status: nextStatus });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
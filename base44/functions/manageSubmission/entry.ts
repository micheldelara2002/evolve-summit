import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import {
  verifyEventMembership,
  EVENT_CURATOR_ROLES,
  EVENT_MANAGER_ROLES,
} from "../../shared/eventAuth.ts";
import { resolveIdentity, normalizeEmail } from "../../shared/identity.ts";
import { ensureSelfPerson } from "../../shared/selfPerson.ts";
import { validateContent, validateAnswers } from "../../shared/submissionForm.ts";
import { incUniqueParticipant, incParticipantsByRole, moveParticipantsByRole } from "../../shared/businessMetrics.ts";
import { recordAccessChange } from "../../shared/accessAudit.ts";

/**
 * manageSubmission — porta única de escrita de Submission (Call for Papers).
 *
 * AUTOR (só o próprio conteúdo):
 *  - create / update / delete / clone: deriva a identidade do usuário autenticado,
 *    valida autoria, janela da chamada e respostas do formulário ATUAL.
 *    Grava APENAS título, resumo, tipo e respostas — status, autoria, avaliador,
 *    sessão e participante NUNCA vêm do cliente.
 *
 * CURADORIA (decisão):
 *  - list: submissões + chamadas que o curador/gestor pode revisar.
 *  - approve / reject / waitlist / cancel: transições válidas, autorizadas por
 *    EventMembership{role:curator} (ou gestão do evento).
 */
const REVIEW_ROLES = [...EVENT_CURATOR_ROLES, ...EVENT_MANAGER_ROLES];

// Transições aceitas por decisão — qualquer outra é recusada.
const TRANSITIONS: Record<string, string[]> = {
  approve: ['pending', 'waitlist', 'rejected', 'cancelled'],
  reject: ['pending', 'waitlist'],
  waitlist: ['pending', 'rejected'],
  cancel: ['approved'],
};

const REVIEW_FIELDS = [
  'id', 'event_id', 'call_for_papers_id', 'person_id', 'submitter_name', 'submitter_email',
  'status', 'title', 'summary', 'proposed_type', 'custom_answers', 'review_notes',
  'session_id', 'participant_id', 'created_date', 'updated_date',
];

function toReviewRecord(submission: any) {
  const out: Record<string, any> = {};
  for (const key of REVIEW_FIELDS) if (key in submission) out[key] = submission[key];
  return out;
}

function ownsSubmission(identity: any, submission: any, userId: string) {
  if (!submission) return false;
  if (submission.created_by_id && submission.created_by_id === userId) return true;
  if (submission.person_id && identity.personIds.includes(submission.person_id)) return true;
  const email = normalizeEmail(submission.submitter_email);
  return !!email && email === identity.emailNorm;
}

function withinWindow(cfp: any) {
  const now = new Date();
  if (cfp?.start_date && new Date(cfp.start_date) > now) return false;
  if (cfp?.end_date && new Date(cfp.end_date) < now) return false;
  return true;
}

function normalizeTitle(value: any) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * A-08 (2026-11-06) — duplo clique ou reenvio não abre duas propostas iguais.
 * Só bloqueia enquanto existe uma proposta PENDENTE da mesma pessoa com o mesmo
 * título na mesma chamada (recusada/cancelada não impede nova tentativa).
 */
async function findDuplicateSubmission(svc: any, { cfpId, personId, email, title }: any) {
  const rows = await svc.entities.Submission.filter({ call_for_papers_id: cfpId, is_deleted: false });
  const wanted = normalizeTitle(title);
  const emailNorm = normalizeEmail(email);
  return (rows || []).find((s: any) =>
    s.status === 'pending' &&
    (s.person_id === personId || normalizeEmail(s.submitter_email) === emailNorm) &&
    normalizeTitle(s.title) === wanted,
  );
}

/**
 * A-02 (2026-11-06) — cancelar uma proposta aprovada devolve o palestrante ao
 * papel anterior. Sem isso ele mantinha acesso de palestrante, aparecia nas
 * listas e continuava contado nos papéis do evento.
 *
 * Só rebaixa quando NENHUM outro vínculo mantém a pessoa como palestrante (outra
 * proposta aprovada ou outra sessão viva) — quem tem duas palestras não perde a
 * segunda. Papéis de gestão (manager/team/partner_rep) nunca são tocados.
 */
async function revertSpeakerParticipant(svc: any, eventId: string, submission: any, actor?: any) {
  const rows = await svc.entities.Participant.filter({ id: submission.participant_id, is_deleted: false });
  const participant = rows?.[0];
  if (!participant || participant.role_in_event !== 'speaker') return;

  const [otherSubs, liveSessions] = await Promise.all([
    svc.entities.Submission.filter({ participant_id: participant.id, status: 'approved', is_deleted: false }),
    svc.entities.Session.filter({ speaker_id: participant.id, is_deleted: false }),
  ]);
  const stillSpeaker =
    (otherSubs || []).some((s: any) => s.id !== submission.id) ||
    (liveSessions || []).length > 0;
  if (stillSpeaker) return;

  const reverted = await svc.entities.Participant.update(participant.id, { role_in_event: 'attendee' });
  await moveParticipantsByRole(svc, eventId, 'speaker', 'attendee', participant.created_date);

  // F3-13 — rebaixar o palestrante REVOGA acesso: trilha obrigatória no backend.
  return await recordAccessChange(svc, {
    eventId,
    entityType: 'Participant',
    entityId: participant.id,
    actor,
    operation: 'role_change',
    reference: `participant:${participant.id}:${reverted?.updated_date || participant.updated_date || participant.created_date || ''}`,
    details: {
      field: 'role_in_event',
      old_value: 'speaker',
      new_value: 'attendee',
      source: 'cfp_cancel',
      submission_id: submission.id,
      participant_email: participant.email || '',
    },
  });
}

/**
 * Claim atômico da decisão. A escrita condicional só casa enquanto a submissão
 * ainda estiver no estado lido (o servidor serializa as escritas: o segundo
 * pedido já não encontra `status`), e grava um token irrepetível em
 * `reviewer_id`; a releitura confirma quem venceu. Dois curadores decidindo ao
 * mesmo tempo nunca criam duas sessões nem dois participantes.
 */
async function claimDecision(svc: any, submission: any, targetStatus: string, userId: string) {
  const token = `claim:${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  await svc.entities.Submission.updateMany(
    { id: submission.id, is_deleted: false, status: submission.status },
    { $set: { status: targetStatus, reviewer_id: token } },
  );
  const [fresh] = await svc.entities.Submission.filter({ id: submission.id });
  return fresh?.reviewer_id === token ? token : null;
}

/** Devolve a submissão ao estado lido quando a decisão falha no meio. */
async function releaseClaim(svc: any, submission: any) {
  await svc.entities.Submission.update(submission.id, {
    status: submission.status,
    reviewer_id: submission.reviewer_id || '',
  });
}

async function loadCfp(svc: any, cfpId: string) {
  if (!cfpId) return null;
  const rows = await svc.entities.CallForPapers.filter({ id: cfpId });
  const cfp = rows?.[0];
  if (!cfp || cfp.is_deleted) return null;
  return cfp;
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = (await req.json().catch(() => ({}))) || {};
    const action = String(body.action || '');
    const svc = base44.asServiceRole;

    // ── CURADORIA: leitura ────────────────────────────────────────────────────
    if (action === 'list') {
      const requestedEventId = String(body.event_id || '');

      if (requestedEventId) {
        const auth = await verifyEventMembership(base44, user, requestedEventId, REVIEW_ROLES);
        if (!auth.authorized) {
          return Response.json({ error: 'Sem permissão de curadoria neste evento.' }, { status: 403 });
        }
      }

      const memberships = await svc.entities.EventMembership.filter({
        user_id: user.id,
        is_active: true,
        is_deleted: false,
        role: { $in: REVIEW_ROLES },
      });
      let eventIds = [...new Set((memberships || []).map((m: any) => m.event_id).filter(Boolean))];
      if (requestedEventId) eventIds = [requestedEventId];
      if (eventIds.length === 0 && user.role === 'admin' && !requestedEventId) {
        // Admin sem vínculo de evento: a fila é o conjunto de chamadas existentes.
        const allCfps = await svc.entities.CallForPapers.filter({ is_deleted: false }, '-created_date', 500);
        eventIds = [...new Set((allCfps || []).map((c: any) => c.event_id).filter(Boolean))];
      }
      if (eventIds.length === 0) {
        return Response.json({ events: [], cfps: [], submissions: [] });
      }

      const [cfps, submissions, events] = await Promise.all([
        svc.entities.CallForPapers.filter({ event_id: { $in: eventIds }, is_deleted: false }),
        svc.entities.Submission.filter({ event_id: { $in: eventIds }, is_deleted: false }),
        svc.entities.Event.filter({ id: { $in: eventIds } }),
      ]);
      const cfpIds = new Set((cfps || []).map((c: any) => c.id));

      return Response.json({
        events: (events || []).map((e: any) => ({ id: e.id, name: e.name, start_date: e.start_date, status: e.status })),
        cfps: (cfps || []).map((c: any) => ({
          id: c.id, event_id: c.event_id, title: c.title, description: c.description,
          start_date: c.start_date, end_date: c.end_date, form_config: c.form_config, is_active: c.is_active,
        })),
        submissions: (submissions || [])
          .filter((s: any) => cfpIds.has(s.call_for_papers_id))
          .map(toReviewRecord),
      });
    }

    // ── AUTOR: minhas propostas ───────────────────────────────────────────────
    // A leitura do próprio autor não passa por RLS de e-mail (que depende de
    // caixa idêntica): a identidade canônica decide o que é dele.
    if (action === 'mine') {
      const identity = await resolveIdentity(base44, user);
      const or: any[] = [{ created_by_id: user.id }];
      if (identity.personIds.length > 0) or.push({ person_id: { $in: identity.personIds } });
      if (identity.emailNorm) or.push({ submitter_email: { $in: identity.emailVariants } });

      const rows = await svc.entities.Submission.filter(
        { is_deleted: false, $or: or },
        '-created_date',
        200,
      );
      return Response.json({ submissions: (rows || []).map(toReviewRecord) });
    }

    // ── AUTOR: criar / editar / excluir / reutilizar ──────────────────────────
    if (['create', 'update', 'delete', 'clone'].includes(action)) {
      const identity = await resolveIdentity(base44, user);

      if (action === 'create') {
        const cfp = await loadCfp(svc, String(body.call_for_papers_id || ''));
        if (!cfp) return Response.json({ error: 'Chamada não encontrada.' }, { status: 404 });
        if (cfp.is_active === false) {
          return Response.json({ error: 'Esta chamada está desativada.' }, { status: 409 });
        }
        if (!withinWindow(cfp)) {
          return Response.json({ error: 'Esta chamada não está aberta para submissões.' }, { status: 409 });
        }

        const content = validateContent(body, { requireType: true });
        if (!content.ok) return Response.json({ error: content.error }, { status: 400 });
        const answers = validateAnswers(cfp.form_config, body.custom_answers);
        if (!answers.ok) return Response.json({ error: answers.error }, { status: 400 });

        const self = await ensureSelfPerson(base44, user);
        if (!self.ok) return Response.json({ error: self.error }, { status: self.status });

        // A-08: duplo clique / reenvio não abre duas propostas iguais.
        const duplicate = await findDuplicateSubmission(svc, {
          cfpId: cfp.id,
          personId: self.personId,
          email: self.email,
          title: content.title,
        });
        if (duplicate) {
          return Response.json({
            error: 'Você já tem uma proposta com este título nesta chamada.',
            submission_id: duplicate.id,
          }, { status: 409 });
        }

        const record = await svc.entities.Submission.create({
          call_for_papers_id: cfp.id,
          event_id: cfp.event_id,
          person_id: self.personId,
          submitter_name: self.personName,
          submitter_email: self.email,
          status: 'pending',
          title: content.title,
          summary: content.summary,
          proposed_type: content.type,
          custom_answers: JSON.stringify(answers.answers),
        });
        return Response.json({ submission: toReviewRecord(record) });
      }

      const submissionId = String(body.submission_id || '');
      const rows = await svc.entities.Submission.filter({ id: submissionId, is_deleted: false });
      const submission = rows?.[0];
      if (!submission) return Response.json({ error: 'Submissão não encontrada.' }, { status: 404 });
      if (!ownsSubmission(identity, submission, user.id)) {
        return Response.json({ error: 'Esta submissão não é sua.' }, { status: 403 });
      }

      if (action === 'delete') {
        if (submission.status !== 'pending') {
          return Response.json({ error: 'Somente submissões pendentes podem ser excluídas.' }, { status: 409 });
        }
        await svc.entities.Submission.update(submission.id, { is_deleted: true });
        return Response.json({ ok: true });
      }

      if (action === 'clone') {
        const targetCfp = await loadCfp(svc, String(body.target_cfp_id || ''));
        if (!targetCfp) return Response.json({ error: 'Chamada de destino não encontrada.' }, { status: 404 });
        if (targetCfp.is_active === false || !withinWindow(targetCfp)) {
          return Response.json({ error: 'A chamada de destino não está aberta.' }, { status: 409 });
        }
        let sourceAnswers: any = {};
        try { sourceAnswers = JSON.parse(submission.custom_answers || '{}') || {}; } catch { sourceAnswers = {}; }
        const answers = validateAnswers(targetCfp.form_config, sourceAnswers);
        if (!answers.ok) return Response.json({ error: answers.error }, { status: 400 });
        const self = await ensureSelfPerson(base44, user);
        if (!self.ok) return Response.json({ error: self.error }, { status: self.status });

        const record = await svc.entities.Submission.create({
          call_for_papers_id: targetCfp.id,
          event_id: targetCfp.event_id,
          person_id: self.personId,
          submitter_name: self.personName,
          submitter_email: self.email,
          status: 'pending',
          title: submission.title,
          summary: submission.summary,
          proposed_type: submission.proposed_type || 'palestra',
          custom_answers: JSON.stringify(answers.answers),
          original_submission_id: submission.id,
        });
        return Response.json({ submission: toReviewRecord(record) });
      }

      // update
      const cfp = await loadCfp(svc, submission.call_for_papers_id);
      if (!cfp) return Response.json({ error: 'Chamada não encontrada.' }, { status: 404 });
      if (cfp.is_active === false || !withinWindow(cfp)) {
        return Response.json({ error: 'Esta chamada não está aberta para edições.' }, { status: 409 });
      }
      if (submission.status !== 'pending') {
        return Response.json({ error: 'Somente submissões pendentes podem ser editadas.' }, { status: 409 });
      }

      const content = validateContent(body, { requireType: true });
      if (!content.ok) return Response.json({ error: content.error }, { status: 400 });
      const answers = validateAnswers(cfp.form_config, body.custom_answers);
      if (!answers.ok) return Response.json({ error: answers.error }, { status: 400 });

      const record = await svc.entities.Submission.update(submission.id, {
        title: content.title,
        summary: content.summary,
        proposed_type: content.type,
        custom_answers: JSON.stringify(answers.answers),
      });
      return Response.json({ submission: toReviewRecord(record) });
    }

    // ── CURADORIA: decisão ────────────────────────────────────────────────────
    const { submission_id, review_notes } = body;
    if (!submission_id || !action) {
      return Response.json({ error: 'submission_id e action são obrigatórios' }, { status: 400 });
    }
    const allowed = TRANSITIONS[action];
    if (!allowed) {
      return Response.json({ error: 'action inválido' }, { status: 400 });
    }

    const subs = await svc.entities.Submission.filter({ id: submission_id, is_deleted: false });
    const submission = subs[0];
    if (!submission) return Response.json({ error: 'Submission não encontrada' }, { status: 404 });

    const cfp = await loadCfp(svc, submission.call_for_papers_id);
    if (!cfp) return Response.json({ error: 'CallForPapers não encontrada' }, { status: 404 });
    const eventId = cfp.event_id;
    if (submission.event_id && submission.event_id !== eventId) {
      return Response.json({
        error: 'Esta submissão está vinculada a outro evento e não pode ser decidida por esta chamada.',
      }, { status: 409 });
    }

    const subAuth = await verifyEventMembership(base44, user, eventId, REVIEW_ROLES);
    if (!subAuth.authorized) {
      return Response.json({ error: 'Forbidden — sem permissão de curadoria neste evento' }, { status: 403 });
    }

    // Duplo clique / nova tentativa em uma submissão já aprovada é idempotente.
    if (action === 'approve' && submission.status === 'approved' && submission.session_id) {
      return Response.json({ ok: true, message: 'Já aprovada', session_id: submission.session_id });
    }

    // A-03 (2026-11-06): retomada. O claim grava "approved" antes de criar
    // participante e sessão; se a execução morrer no meio, a proposta fica
    // aprovada e sem sessão — e sem esta exceção ninguém consegue aprová-la de
    // novo. "approved" sem session_id é exatamente esse estado: retoma daqui.
    const isResume = action === 'approve' && submission.status === 'approved' && !submission.session_id;
    if (!isResume && !allowed.includes(submission.status)) {
      return Response.json({
        error: `Não é possível executar "${action}" em uma submissão ${submission.status}.`,
      }, { status: 409 });
    }

    const targetStatus =
      action === 'approve' ? 'approved'
        : action === 'reject' ? 'rejected'
        : action === 'waitlist' ? 'waitlist'
        : 'cancelled';

    const token = await claimDecision(svc, submission, targetStatus, user.id);
    if (!token) {
      return Response.json({
        error: 'Esta submissão acabou de ser movida por outra pessoa. Recarregue a fila.',
      }, { status: 409 });
    }

    const reviewer = {
      reviewer_id: user.id,
      reviewer_name: user.full_name || user.email,
    };
    const notes = String(review_notes || '').slice(0, 2000);

    try {
      if (action === 'approve') {
        let found = await svc.entities.Participant.filter({
          event_id: eventId,
          email: submission.submitter_email,
          is_deleted: false,
        });
        let participant = found[0];
        let promotedFrom: string | null = null;
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
          await incUniqueParticipant(svc, eventId, participant.created_date);
          await incParticipantsByRole(svc, eventId, 'speaker', participant.created_date);
        } else if (participant.role_in_event !== 'speaker') {
          const oldRole = participant.role_in_event;
          await svc.entities.Participant.update(participant.id, { role_in_event: 'speaker' });
          await moveParticipantsByRole(svc, eventId, oldRole, 'speaker', participant.created_date);
          promotedFrom = oldRole;
        }

        // F3-13 — aprovar a proposta concede acesso de PALESTRANTE: a concessão
        // passa a ter trilha gerada pelo backend. A chave é determinística por
        // participante + ocorrência, então a retomada da A-03 não duplica; a
        // falha de auditoria não derruba uma aprovação legítima (a curadoria é
        // fluxo de conteúdo, não operação financeira) — o estado é informado.
        const roleAuditState = await recordAccessChange(svc, {
          eventId,
          entityType: 'Participant',
          entityId: participant.id,
          actor: user,
          operation: 'role_change',
          reference: `participant:${participant.id}:${participant.updated_date || participant.created_date || ''}`,
          details: {
            field: 'role_in_event',
            old_value: promotedFrom,
            new_value: 'speaker',
            source: 'cfp_approve',
            submission_id: submission.id,
            participant_email: participant.email || '',
          },
        });

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
          review_notes: notes,
          ...reviewer,
        });

        return Response.json({
          ok: true,
          session_id: session.id,
          participant_id: participant.id,
          audit_state: roleAuditState,
        });
      }

      if (submission.session_id) {
        const sessList = await svc.entities.Session.filter({ id: submission.session_id });
        const existing = sessList[0];
        if (existing && !existing.is_deleted) {
          await svc.entities.Session.update(existing.id, { is_deleted: true });
        }
      }

      // A-02: cancelar uma proposta aprovada também desfaz o palestrante.
      const hadParticipant = !!submission.participant_id;
      const revokeAuditState = (targetStatus === 'cancelled' && hadParticipant)
        ? await revertSpeakerParticipant(svc, eventId, submission, user)
        : null;

      await svc.entities.Submission.update(submission.id, {
        status: targetStatus,
        review_notes: notes,
        ...reviewer,
        ...(hadParticipant ? { participant_id: '' } : {}),
      });

      return Response.json({
        ok: true,
        status: targetStatus,
        ...(revokeAuditState ? { audit_state: revokeAuditState } : {}),
      });
    } catch (error) {
      await releaseClaim(svc, submission);
      throw error;
    }
  } catch (error: any) {
    console.error('manageSubmission error:', error?.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { normalizeEmail } from "../../shared/identity.ts";
import { ensureSelfPerson } from "../../shared/selfPerson.ts";
import { validateContent, validateAnswers } from "../../shared/submissionForm.ts";

// Status e papéis aceitos por decisão de gestão — qualquer outro é recusado.
const PROMOTE_STATUSES = ['in_review', 'finalist', 'winner', 'rejected'];
const PROMOTE_ROLES = ['winner', 'attendee', 'speaker'];

/**
 * manageAward — backend function do módulo de premiação (fluxo CFP-like).
 *
 * Ações:
 *  - submitCase: candidato inscreve um case. Valida janela de inscrição,
 *      resolve/cria Person, garante EventMembership{role:entrante}, cria AwardSubmission.
 *  - assignReviewer: admin designa avaliador(es) a uma inscrição.
 *  - saveEvaluation: avaliador designado envia/atualiza sua nota (calcula total pelos critérios).
 *  - listMyAssignments: avaliador vê inscrições designadas a ele + suas avaliações.
 *  - listResults: admin agrega avaliações por inscrição (ranking).
 *  - promoteWinner: admin define status (finalist/winner/rejected) e opcionalmente
 *      promove o papel do candidato de 'entrant' para 'winner'/'attendee' (libera acesso ao evento).
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const { action } = body || {};
    const svc = base44.asServiceRole;

    // ── submitCase ──────────────────────────────────────────────────────────
    if (action === 'submitCase') {
      const { award_id } = body;
      if (!award_id) {
        return Response.json({ error: 'award_id obrigatório' }, { status: 400 });
      }
      const configs = await svc.entities.AwardConfig.filter({ id: award_id });
      const config = configs[0];
      if (!config || config.is_deleted) return Response.json({ error: 'Premiação não encontrada' }, { status: 404 });
      if (!config.is_active) return Response.json({ error: 'Premiação inativa' }, { status: 400 });
      const now = new Date();
      if (config.start_date && new Date(config.start_date) > now) {
        return Response.json({ error: 'Inscrições ainda não abertas' }, { status: 400 });
      }
      if (config.end_date && new Date(config.end_date) < now) {
        return Response.json({ error: 'Inscrições encerradas' }, { status: 400 });
      }

      // Conteúdo e respostas validados contra o formulário ATUAL da premiação.
      const content = validateContent(body);
      if (!content.ok) return Response.json({ error: content.error }, { status: 400 });
      const answers = validateAnswers(config.form_config, body.custom_answers);
      if (!answers.ok) return Response.json({ error: answers.error }, { status: 400 });

      // Identidade canônica (User → Person). Ambiguidade é NEGADA.
      const self = await ensureSelfPerson(base44, user);
      if (!self.ok) return Response.json({ error: self.error }, { status: self.status });
      const personId = self.personId;
      const personName = self.personName;
      const personEmail = self.email;

      // garante EventMembership{entrant} (idempotente) — service role bypassa RLS create
      const existingM = await svc.entities.EventMembership.filter({
        event_id: config.event_id, person_id: personId, role: 'entrant', is_deleted: false,
      });
      if (existingM.length === 0) {
        await svc.entities.EventMembership.create({
          event_id: config.event_id,
          person_id: personId,
          person_name: personName,
          user_id: user.id,
          user_email: personEmail,
          role: 'entrant',
          is_active: true,
        });
      }

      const submission = await svc.entities.AwardSubmission.create({
        award_id,
        event_id: config.event_id,
        person_id: personId,
        submitter_name: personName,
        submitter_email: personEmail,
        title: content.title,
        summary: content.summary,
        custom_answers: JSON.stringify(answers.answers),
        status: 'pending',
        assigned_reviewer_ids: '[]',
      });
      return Response.json({ ok: true, submission });
    }

    // ── assignReviewers: admin define a banca avaliadora de uma premiação ────
    if (action === 'assignReviewers') {
      const { award_id, reviewer_user_ids } = body;
      if (!award_id) return Response.json({ error: 'award_id obrigatório' }, { status: 400 });
      const configs = await svc.entities.AwardConfig.filter({ id: award_id, is_deleted: false });
      if (!configs[0]) return Response.json({ error: 'Premiação não encontrada' }, { status: 404 });
      const config = configs[0];
      // P0.2: Event-scoped authorization
      const awardAuth = await verifyEventMembership(base44, user, config.event_id, EVENT_MANAGER_ROLES);
      if (!awardAuth.authorized) return Response.json({ error: 'Forbidden' }, { status: 403 });

      // Banca só aceita Users com EventMembership{reviewer} ATIVA neste evento.
      const ids = [...new Set((Array.isArray(reviewer_user_ids) ? reviewer_user_ids : []).map(String).filter(Boolean))];
      if (ids.length > 0) {
        const valid = await svc.entities.EventMembership.filter({
          event_id: config.event_id,
          role: 'reviewer',
          is_active: true,
          is_deleted: false,
          user_id: { $in: ids },
        });
        const validIds = new Set((valid || []).map((m: any) => m.user_id));
        const invalid = ids.filter((id) => !validIds.has(id));
        if (invalid.length > 0) {
          return Response.json({
            error: 'Só é possível designar avaliadores com papel de avaliador ativo neste evento.',
            invalid_user_ids: invalid,
          }, { status: 400 });
        }
      }

      await svc.entities.AwardConfig.update(award_id, { assigned_reviewer_ids: JSON.stringify(ids) });
      return Response.json({ ok: true, assigned_reviewer_ids: ids });
    }

    // ── saveEvaluation ───────────────────────────────────────────────────────
    if (action === 'saveEvaluation') {
      const { submission_id, scores, notes } = body;
      if (!submission_id) return Response.json({ error: 'submission_id obrigatório' }, { status: 400 });
      const subs = await svc.entities.AwardSubmission.filter({ id: submission_id, is_deleted: false });
      const sub = subs[0];
      if (!sub) return Response.json({ error: 'Inscrição não encontrada' }, { status: 404 });

      const configs = await svc.entities.AwardConfig.filter({ id: sub.award_id, is_deleted: false });
      const config = configs[0];
      if (!config) return Response.json({ error: 'Premiação não encontrada' }, { status: 404 });

      // Avaliador precisa estar na banca E ter papel 'reviewer' ativo no evento.
      if (user.role !== 'admin') {
        let banca = [];
        try { banca = JSON.parse(config.assigned_reviewer_ids || '[]'); } catch { banca = []; }
        if (!banca.includes(user.id)) {
          return Response.json({ error: 'Forbidden — você não faz parte da banca desta premiação' }, { status: 403 });
        }
        const reviewerAuth = await verifyEventMembership(base44, user, sub.event_id, ['reviewer']);
        if (!reviewerAuth.authorized) {
          return Response.json({ error: 'Forbidden — você não é avaliador deste evento' }, { status: 403 });
        }
      }

      let criteria = [];
      try { criteria = JSON.parse(config.criteria_config || '[]'); } catch { criteria = []; }
      if (!Array.isArray(criteria) || criteria.length === 0) {
        return Response.json({ error: 'Esta premiação não tem critérios de avaliação definidos.' }, { status: 409 });
      }

      // NOTAS: só critérios existentes, valor numérico, não negativo e dentro do máximo.
      const scoresObj = scores && typeof scores === 'object' && !Array.isArray(scores) ? scores : {};
      const known = new Set(criteria.map((c: any) => String(c?.id)));
      for (const key of Object.keys(scoresObj)) {
        if (!known.has(key)) {
          return Response.json({ error: `Critério inválido na avaliação: ${key}` }, { status: 400 });
        }
      }

      const cleanScores: Record<string, number> = {};
      let total = 0;
      for (const c of criteria) {
        const id = String(c?.id || '');
        if (!id) continue;
        const label = c?.label || id;
        const max = Number(c?.max_score);
        const weightRaw = Number(c?.weight);
        const weight = Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : 1;

        const raw = scoresObj[id];
        let value = 0;
        if (raw !== undefined && raw !== null && raw !== '') {
          value = Number(raw);
          if (!Number.isFinite(value)) {
            return Response.json({ error: `Nota inválida em "${label}": informe um número.` }, { status: 400 });
          }
          if (value < 0) {
            return Response.json({ error: `Nota negativa não é permitida em "${label}".` }, { status: 400 });
          }
          if (Number.isFinite(max) && max > 0 && value > max) {
            return Response.json({ error: `A nota de "${label}" deve ser no máximo ${max}.` }, { status: 400 });
          }
        }
        cleanScores[id] = value;
        total += value * weight;
      }
      total = Math.round(total * 100) / 100;

      const payload = {
        event_id: sub.event_id,
        award_id: sub.award_id,
        submission_id,
        reviewer_user_id: user.id,
        reviewer_name: user.full_name || user.email,
        scores: JSON.stringify(cleanScores),
        total_score: total,
        notes: String(notes || '').slice(0, 5000),
        status: 'submitted',
      };

      const existing = await svc.entities.AwardEvaluation.filter({ submission_id, reviewer_user_id: user.id, is_deleted: false });
      let result;
      if (existing[0]) {
        await svc.entities.AwardEvaluation.update(existing[0].id, payload);
        result = { id: existing[0].id, ...payload };
      } else {
        result = await svc.entities.AwardEvaluation.create(payload);
      }
      return Response.json({ ok: true, evaluation: result });
    }

    // ── listMyAssignments: inscrições das premiações cuja banca inclui o user ─
    if (action === 'listMyAssignments') {
      // Avaliador = EventMembership{reviewer} ativa. Sem o papel, não há designação.
      const reviewerMemberships = await svc.entities.EventMembership.filter({
        user_id: user.id,
        role: 'reviewer',
        is_active: true,
        is_deleted: false,
      });
      const myEventIds = new Set((reviewerMemberships || []).map((m: any) => m.event_id));
      if (user.role !== 'admin' && myEventIds.size === 0) {
        return Response.json({ ok: true, submissions: [], configs: {}, evaluations: {} });
      }

      const allConfigs = await svc.entities.AwardConfig.filter({ is_active: true, is_deleted: false }, undefined, 1000);
      const myConfigs = allConfigs.filter((c) => {
        if (user.role !== 'admin' && !myEventIds.has(c.event_id)) return false;
        let banca = [];
        try { banca = JSON.parse(c.assigned_reviewer_ids || '[]'); } catch { banca = []; }
        return banca.includes(user.id);
      });
      if (myConfigs.length === 0) {
        return Response.json({ ok: true, submissions: [], configs: {}, evaluations: {} });
      }
      const configIds = myConfigs.map((c) => c.id);
      const allSubs = await svc.entities.AwardSubmission.filter({ is_deleted: false }, undefined, 1000);
      const mine = allSubs.filter((s) => configIds.includes(s.award_id));
      const configMap = {};
      for (const c of myConfigs) configMap[c.id] = c;
      const evals = await svc.entities.AwardEvaluation.filter({ reviewer_user_id: user.id, is_deleted: false }, undefined, 1000);
      const evalMap = {};
      for (const e of evals) evalMap[e.submission_id] = e;
      return Response.json({ ok: true, submissions: mine, configs: configMap, evaluations: evalMap });
    }

    // ── listResults ──────────────────────────────────────────────────────────
    if (action === 'listResults') {
      const { event_id, award_id } = body;
      if (!event_id) return Response.json({ error: 'event_id obrigatório' }, { status: 400 });
      // P0.2: Event-scoped authorization
      const resultsAuth = await verifyEventMembership(base44, user, event_id, EVENT_MANAGER_ROLES);
      if (!resultsAuth.authorized) return Response.json({ error: 'Forbidden' }, { status: 403 });
      const evalQuery = { event_id, is_deleted: false };
      if (award_id) evalQuery.award_id = award_id;
      const evaluations = await svc.entities.AwardEvaluation.filter(evalQuery, undefined, 1000);
      const subs = await svc.entities.AwardSubmission.filter({ event_id, is_deleted: false }, undefined, 1000);
      const bySub = {};
      for (const e of evaluations) (bySub[e.submission_id] = bySub[e.submission_id] || []).push(e);
      const results = subs.map((s) => {
        const evs = bySub[s.id] || [];
        const avg = evs.length ? evs.reduce((a, e) => a + (e.total_score || 0), 0) / evs.length : 0;
        return { submission: s, evaluations: evs, avg_score: Math.round(avg * 100) / 100, reviewers_count: evs.length };
      }).sort((a, b) => b.avg_score - a.avg_score);
      return Response.json({ ok: true, results });
    }

    // ── promoteWinner ────────────────────────────────────────────────────────
    if (action === 'promoteWinner') {
      const { submission_id, status, new_role } = body;
      if (!submission_id || !status) return Response.json({ error: 'submission_id e status obrigatórios' }, { status: 400 });
      if (!PROMOTE_STATUSES.includes(status)) {
        return Response.json({ error: `Status inválido: ${status}` }, { status: 400 });
      }
      if (new_role && !PROMOTE_ROLES.includes(new_role)) {
        return Response.json({ error: `Papel inválido: ${new_role}` }, { status: 400 });
      }
      const subs = await svc.entities.AwardSubmission.filter({ id: submission_id, is_deleted: false });
      const sub = subs[0];
      if (!sub) return Response.json({ error: 'Inscrição não encontrada' }, { status: 404 });
      // P0.2: Event-scoped authorization
      const promoteAuth = await verifyEventMembership(base44, user, sub.event_id, EVENT_MANAGER_ROLES);
      if (!promoteAuth.authorized) return Response.json({ error: 'Forbidden' }, { status: 403 });
      if (new_role && !sub.person_id) {
        return Response.json({ error: 'A inscrição não tem pessoa vinculada.' }, { status: 409 });
      }

      // Liberar acesso exige CONTA: papel de evento mora na EventMembership do User.
      let targetUserId = '';
      if (new_role) {
        const byPerson = await svc.entities.User.filter({ person_id: sub.person_id });
        targetUserId = byPerson?.[0]?.id || '';
        if (!targetUserId && sub.submitter_email) {
          const byEmail = await svc.entities.User.filter({ email: normalizeEmail(sub.submitter_email) });
          targetUserId = byEmail?.[0]?.id || '';
        }
        if (!targetUserId) {
          return Response.json({
            error: 'O candidato ainda não tem conta no app. Envie o convite de cadastro antes de liberar o acesso.',
          }, { status: 409 });
        }
      }

      await svc.entities.AwardSubmission.update(submission_id, { status });

      if (new_role) {
        const [sameRole, entrant] = await Promise.all([
          svc.entities.EventMembership.filter({ event_id: sub.event_id, person_id: sub.person_id, role: new_role, is_deleted: false }),
          svc.entities.EventMembership.filter({ event_id: sub.event_id, person_id: sub.person_id, role: 'entrant', is_deleted: false }),
        ]);
        if (sameRole[0]) {
          // Papel já existe: apenas encerra o vínculo de candidato (sem duplicar).
          if (entrant[0]) {
            await svc.entities.EventMembership.update(entrant[0].id, { is_active: false, is_deleted: true });
          }
        } else if (entrant[0]) {
          await svc.entities.EventMembership.update(entrant[0].id, {
            role: new_role,
            user_id: targetUserId,
            is_active: true,
            is_deleted: false,
          });
        } else {
          await svc.entities.EventMembership.create({
            event_id: sub.event_id,
            person_id: sub.person_id,
            person_name: sub.submitter_name,
            user_id: targetUserId,
            user_email: normalizeEmail(sub.submitter_email || ''),
            role: new_role,
            is_active: true,
          });
        }
      }
      return Response.json({ ok: true });
    }

    // ── listSubmissions: gestão lê as inscrições do evento ───────────────────
    if (action === 'listSubmissions') {
      const { event_id } = body;
      if (!event_id) return Response.json({ error: 'event_id obrigatório' }, { status: 400 });
      const listAuth = await verifyEventMembership(base44, user, event_id, EVENT_MANAGER_ROLES);
      if (!listAuth.authorized) return Response.json({ error: 'Forbidden' }, { status: 403 });
      const submissions = await svc.entities.AwardSubmission.filter({ event_id, is_deleted: false });
      return Response.json({ ok: true, submissions });
    }

    // ── setStatus: gestão muda o andamento sem liberar acesso ────────────────
    if (action === 'setStatus') {
      const { submission_id } = body;
      const status = String(body.status || '');
      if (!submission_id) return Response.json({ error: 'submission_id obrigatório' }, { status: 400 });
      if (!['pending', 'in_review', 'finalist', 'winner', 'rejected'].includes(status)) {
        return Response.json({ error: `Status inválido: ${status}` }, { status: 400 });
      }
      const subs = await svc.entities.AwardSubmission.filter({ id: submission_id, is_deleted: false });
      const sub = subs[0];
      if (!sub) return Response.json({ error: 'Inscrição não encontrada' }, { status: 404 });
      const statusAuth = await verifyEventMembership(base44, user, sub.event_id, EVENT_MANAGER_ROLES);
      if (!statusAuth.authorized) return Response.json({ error: 'Forbidden' }, { status: 403 });
      await svc.entities.AwardSubmission.update(submission_id, { status });
      return Response.json({ ok: true, status });
    }

    return Response.json({ error: 'action inválido' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
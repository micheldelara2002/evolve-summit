import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

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
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { action } = body || {};
    const svc = base44.asServiceRole;

    // ── submitCase ──────────────────────────────────────────────────────────
    if (action === 'submitCase') {
      const { award_id, title, summary, custom_answers } = body;
      if (!award_id || !title?.trim()) {
        return Response.json({ error: 'award_id e title obrigatórios' }, { status: 400 });
      }
      const configs = await svc.entities.AwardConfig.filter({ id: award_id, is_deleted: false });
      const config = configs[0];
      if (!config) return Response.json({ error: 'Premiação não encontrada' }, { status: 404 });
      if (!config.is_active) return Response.json({ error: 'Premiação inativa' }, { status: 400 });
      const now = new Date();
      if (config.start_date && new Date(config.start_date) > now) {
        return Response.json({ error: 'Inscrições ainda não abertas' }, { status: 400 });
      }
      if (config.end_date && new Date(config.end_date) < now) {
        return Response.json({ error: 'Inscrições encerradas' }, { status: 400 });
      }

      // resolve/cria Person
      let personId = user.person_id;
      let personName = user.full_name || user.email;
      const personEmail = user.email;
      if (!personId) {
        const byEmail = user.email ? await svc.entities.Person.filter({ contact_email: user.email }) : [];
        if (byEmail[0]) {
          personId = byEmail[0].id;
          personName = byEmail[0].full_name || personName;
        } else {
          const created = await base44.entities.Person.create({ full_name: personName, contact_email: personEmail });
          personId = created.id;
          await base44.auth.updateMe({ person_id: personId });
        }
      }

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

      const submission = await base44.entities.AwardSubmission.create({
        award_id,
        event_id: config.event_id,
        person_id: personId,
        submitter_name: personName,
        submitter_email: personEmail,
        title: title.trim(),
        summary: (summary || '').trim(),
        custom_answers: JSON.stringify(custom_answers || {}),
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
      // P0.2: Event-scoped authorization
      const awardAuth = await verifyEventMembership(base44, user, configs[0].event_id, EVENT_MANAGER_ROLES);
      if (!awardAuth.authorized) return Response.json({ error: 'Forbidden' }, { status: 403 });
      await svc.entities.AwardConfig.update(award_id, { assigned_reviewer_ids: JSON.stringify(reviewer_user_ids || []) });
      return Response.json({ ok: true, assigned_reviewer_ids: reviewer_user_ids || [] });
    }

    // ── saveEvaluation ───────────────────────────────────────────────────────
    if (action === 'saveEvaluation') {
      const { submission_id, scores, notes, status } = body;
      if (!submission_id) return Response.json({ error: 'submission_id obrigatório' }, { status: 400 });
      const subs = await svc.entities.AwardSubmission.filter({ id: submission_id, is_deleted: false });
      const sub = subs[0];
      if (!sub) return Response.json({ error: 'Inscrição não encontrada' }, { status: 404 });

      const configs = await svc.entities.AwardConfig.filter({ id: sub.award_id, is_deleted: false });
      const config = configs[0];
      if (user.role !== 'admin') {
        let banca = [];
        try { banca = JSON.parse(config?.assigned_reviewer_ids || '[]'); } catch { banca = []; }
        if (!banca.includes(user.id)) {
          return Response.json({ error: 'Forbidden — você não faz parte da banca desta premiação' }, { status: 403 });
        }
      }
      let criteria = [];
      try { criteria = JSON.parse(config?.criteria_config || '[]'); } catch { criteria = []; }
      const scoresObj = scores || {};
      let total = 0;
      for (const c of criteria) total += Number(scoresObj[c.id] ?? 0) * (c.weight || 1);
      total = Math.round(total * 100) / 100;

      const payload = {
        event_id: sub.event_id,
        award_id: sub.award_id,
        submission_id,
        reviewer_user_id: user.id,
        reviewer_name: user.full_name || user.email,
        scores: JSON.stringify(scoresObj),
        total_score: total,
        notes: notes || '',
        status: status || 'submitted',
      };

      const existing = await svc.entities.AwardEvaluation.filter({ submission_id, reviewer_user_id: user.id, is_deleted: false });
      let result;
      if (existing[0]) {
        await svc.entities.AwardEvaluation.update(existing[0].id, payload);
        result = { id: existing[0].id, ...payload };
      } else {
        result = await base44.entities.AwardEvaluation.create(payload);
      }
      return Response.json({ ok: true, evaluation: result });
    }

    // ── listMyAssignments: inscrições das premiações cuja banca inclui o user ─
    if (action === 'listMyAssignments') {
      const allConfigs = await svc.entities.AwardConfig.filter({ is_active: true, is_deleted: false }, undefined, 1000);
      const myConfigs = allConfigs.filter((c) => {
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
      const subs = await svc.entities.AwardSubmission.filter({ id: submission_id, is_deleted: false });
      const sub = subs[0];
      if (!sub) return Response.json({ error: 'Inscrição não encontrada' }, { status: 404 });
      // P0.2: Event-scoped authorization
      const promoteAuth = await verifyEventMembership(base44, user, sub.event_id, EVENT_MANAGER_ROLES);
      if (!promoteAuth.authorized) return Response.json({ error: 'Forbidden' }, { status: 403 });
      await svc.entities.AwardSubmission.update(submission_id, { status });

      if (new_role && sub.person_id) {
        const existing = await svc.entities.EventMembership.filter({ event_id: sub.event_id, person_id: sub.person_id, role: 'entrant', is_deleted: false });
        if (existing[0]) {
          await svc.entities.EventMembership.update(existing[0].id, { role: new_role });
        } else {
          await svc.entities.EventMembership.create({
            event_id: sub.event_id,
            person_id: sub.person_id,
            person_name: sub.submitter_name,
            user_id: '',
            user_email: sub.submitter_email || '',
            role: new_role,
            is_active: true,
          });
        }
      }
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'action inválido' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
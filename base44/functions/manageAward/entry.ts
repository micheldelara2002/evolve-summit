import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * manageAward — backend function do módulo de premiação.
 *
 * Ações:
 *  - saveEvaluation: revisor envia/atualiza sua avaliação de uma indicação.
 *      Verifica EventMembership role=reviewer (ou admin) para o evento da indicação.
 *      Calcula total_score a partir dos critérios da categoria.
 *      Cria como user-scoped (created_by_id = revisor) ou atualiza avaliação existente.
 *  - listResults: admin only — agrega avaliações por indicação (média + contagem).
 */
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();
    const { action } = body || {};
    const svc = base44.asServiceRole;

    if (action === 'saveEvaluation') {
      const { nomination_id, scores, notes, status } = body;
      if (!nomination_id) return Response.json({ error: 'nomination_id obrigatório' }, { status: 400 });

      const noms = await svc.entities.AwardNomination.filter({ id: nomination_id, is_deleted: false });
      const nomination = noms[0];
      if (!nomination) return Response.json({ error: 'Indicação não encontrada' }, { status: 404 });

      // Verifica papel de avaliador no evento (ou admin)
      if (user.role !== 'admin') {
        const memberships = await svc.entities.EventMembership.filter({
          event_id: nomination.event_id,
          user_id: user.id,
          role: 'reviewer',
          is_active: true,
          is_deleted: false,
        });
        if (memberships.length === 0) {
          return Response.json({ error: 'Forbidden — você não é avaliador deste evento' }, { status: 403 });
        }
      }

      // Carrega critérios da categoria para calcular total
      const cats = await svc.entities.AwardCategory.filter({ id: nomination.category_id, is_deleted: false });
      const category = cats[0];
      let criteria = [];
      try { criteria = JSON.parse(category?.criteria_config || '[]'); } catch { criteria = []; }

      const scoresObj = scores || {};
      let total = 0;
      for (const c of criteria) {
        total += Number(scoresObj[c.id] ?? 0) * (c.weight || 1);
      }
      total = Math.round(total * 100) / 100;

      const payload = {
        event_id: nomination.event_id,
        category_id: nomination.category_id,
        nomination_id,
        reviewer_user_id: user.id,
        reviewer_name: user.full_name || user.email,
        scores: JSON.stringify(scoresObj),
        total_score: total,
        notes: notes || '',
        status: status || 'submitted',
      };

      const existing = await svc.entities.AwardEvaluation.filter({
        nomination_id,
        reviewer_user_id: user.id,
        is_deleted: false,
      });

      let result;
      if (existing[0]) {
        await svc.entities.AwardEvaluation.update(existing[0].id, payload);
        result = { id: existing[0].id, ...payload };
      } else {
        // user-scoped create -> created_by_id = revisor (RLS read owner-scoped)
        result = await base44.entities.AwardEvaluation.create(payload);
      }
      return Response.json({ ok: true, evaluation: result });
    }

    if (action === 'listResults') {
      if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });
      const { event_id, category_id } = body;
      if (!event_id) return Response.json({ error: 'event_id obrigatório' }, { status: 400 });

      const evalQuery = { event_id, is_deleted: false };
      if (category_id) evalQuery.category_id = category_id;
      const evaluations = await svc.entities.AwardEvaluation.filter(evalQuery, undefined, 1000);
      const nominations = await svc.entities.AwardNomination.filter({ event_id, is_deleted: false }, undefined, 1000);

      const byNom = {};
      for (const e of evaluations) {
        (byNom[e.nomination_id] = byNom[e.nomination_id] || []).push(e);
      }
      const results = nominations
        .map((n) => {
          const evals = byNom[n.id] || [];
          const avg = evals.length ? evals.reduce((s, e) => s + (e.total_score || 0), 0) / evals.length : 0;
          return { nomination: n, evaluations: evals, avg_score: Math.round(avg * 100) / 100, reviewers_count: evals.length };
        })
        .sort((a, b) => b.avg_score - a.avg_score);

      return Response.json({ ok: true, results });
    }

    return Response.json({ error: 'action inválido' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
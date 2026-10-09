import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { deterministicCompare } from "../../shared/deterministicSurvivor.ts";

function buildIdempotencyKey({ eventId, participantId, acao, refId, limiteTipo }) {
  switch (limiteTipo) {
    case "one_shot":
      return `${eventId}:${participantId}:${acao}`;
    case "por_sessao":
    case "por_estande":
      return `${eventId}:${participantId}:${acao}:${refId}`;
    case "por_par_usuarios":
      return `${eventId}:${participantId}:${acao}:${refId}`;
    default:
      return `${eventId}:${participantId}:${acao}:${refId}`;
  }
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { eventId, participantId, personId, acao, refId = "" } = await req.json();
    if (!eventId || !participantId || !acao) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }

    // P0.2 + P0 residual: Action-specific authorization — prevents arbitrary cross-participant scoring.
    // P0 residual: event_id in the query guarantees the participant belongs to eventId —
    // cross-event scoring is impossible at the query level, not just via a post-check.
    const targetParts = await base44.asServiceRole.entities.Participant.filter({ id: participantId, event_id: eventId, is_deleted: false });
    const targetPart = targetParts[0];
    if (!targetPart) return Response.json({ error: 'Participante não encontrado neste evento.' }, { status: 404 });
    // P1 — personId consistency: when provided, must match the Participant's person_id.
    if (personId && targetPart.person_id !== personId) {
      return Response.json({ error: 'personId não corresponde ao Participant informado.' }, { status: 400 });
    }
    const isOwner = targetPart.email?.toLowerCase() === user.email?.toLowerCase();
    const isAdminUser = user.role === 'admin';
    if (!isOwner && !isAdminUser) {
      if (acao !== 'conexao_aceita') {
        return Response.json({ error: 'Sem permissão para creditar pontos para este participante.' }, { status: 403 });
      }

      // conexao_aceita: caller must be a participant in the same event AND there
      // must be an actual accepted Connection between caller and target. Merely
      // being in the same event is not enough to manufacture points.
      const callerParts = await base44.asServiceRole.entities.Participant.filter({
        event_id: targetPart.event_id, email: user.email, is_deleted: false,
      });
      const callerPart = callerParts[0];
      if (!callerPart || !callerPart.person_id || !targetPart.person_id) {
        return Response.json({ error: 'Sem permissão para creditar pontos para este participante.' }, { status: 403 });
      }
      const [personA, personB] = callerPart.person_id < targetPart.person_id
        ? [callerPart.person_id, targetPart.person_id]
        : [targetPart.person_id, callerPart.person_id];
      const connections = await base44.asServiceRole.entities.Connection.filter({
        event_id: targetPart.event_id,
        person_a_id: personA,
        person_b_id: personB,
        is_deleted: false,
      });
      if (connections.length === 0) {
        return Response.json({ error: 'Conexão aceita não encontrada para esta pontuação.' }, { status: 403 });
      }
    }

    // P0 (2026-10-09) — Evidência server-side por ação: além do vínculo
    // participante/evento e da posse, o crédito só acontece quando o registro
    // que COMPROVA a ação existe no banco — a tela que dispara a pontuação não
    // é fonte de verdade:
    //   presenca_sessao   → SessionAttendance (event, session, participant, is_present)
    //   avaliacao_sessao  → SessionReview do participante para a sessão
    //   pergunta_valida   → SessionQuestion do participante com >= 25 caracteres
    //   visita_estande    → Lead (booth_scan) do participante no parceiro refId
    //   completude_perfil → Person do participante com ao menos 1 campo útil
    //                       preenchido (mesma regra da tela — profileCompleteness)
    // conexao_aceita já valida a Connection acima; resgate_realizado não credita
    // pontos. Admin mantém bypass (crédito manual de correção).
    if (user.role !== 'admin') {
      const svcEntities = base44.asServiceRole.entities;
      let evidence: any[] = [];
      if (acao === 'presenca_sessao') {
        evidence = await svcEntities.SessionAttendance.filter({
          event_id: eventId, session_id: refId, participant_id: participantId, is_present: true,
        });
      } else if (acao === 'avaliacao_sessao') {
        evidence = await svcEntities.SessionReview.filter({
          event_id: eventId, session_id: refId, participant_id: participantId,
        });
      } else if (acao === 'pergunta_valida') {
        const questions = await svcEntities.SessionQuestion.filter({
          event_id: eventId, session_id: refId, participant_id: participantId, is_deleted: false,
        });
        for (let q = 0; q < questions.length; q++) {
          if (String(questions[q].question || '').trim().length >= 25) { evidence = [questions[q]]; break; }
        }
      } else if (acao === 'visita_estande') {
        evidence = await svcEntities.Lead.filter({
          event_id: eventId, partner_id: refId, participant_id: participantId, is_deleted: false,
        });
      } else if (acao === 'completude_perfil') {
        const COMPLETENESS_FIELDS = ['contact_email', 'phone', 'company', 'job_title', 'bio', 'linkedin', 'instagram', 'website', 'youtube'];
        let filled = 0;
        if (targetPart.person_id) {
          const person = (await svcEntities.Person.filter({ id: targetPart.person_id }))[0];
          if (person) {
            if (person.full_name && String(person.full_name).trim()) filled++;
            for (let f = 0; f < COMPLETENESS_FIELDS.length; f++) {
              const v = person[COMPLETENESS_FIELDS[f]];
              if (v !== null && v !== undefined && String(v).trim() !== '') filled++;
            }
          }
        }
        if (filled > 0) evidence = ['ok'];
      }
      const needsEvidence = acao === 'presenca_sessao' || acao === 'avaliacao_sessao' ||
        acao === 'pergunta_valida' || acao === 'visita_estande' || acao === 'completude_perfil';
      if (needsEvidence && evidence.length === 0) {
        return Response.json({
          credited: false, pontos: 0, reason: 'no_evidence',
          error: 'Evidência da ação não encontrada — pontos não creditados.',
        }, { status: 403 });
      }
    }

    // Resgate: cria PointTransaction com 0 pontos, sem creditar
    if (acao === "resgate_realizado") {
      const chave = `${eventId}:${participantId}:${acao}:${refId}`;
      const existing = await base44.asServiceRole.entities.PointTransaction.filter({ chave_idempotencia: chave });
      if (existing && existing.length > 0) {
        return Response.json({ credited: false, pontos: 0, reason: "limit_reached" });
      }
      const resgateTx = await base44.asServiceRole.entities.PointTransaction.create({
        event_id: eventId,
        participant_id: participantId,
        person_id: personId || undefined,
        acao,
        pontos: 0,
        chave_idempotencia: chave,
        ref_id: refId || undefined,
        descricao: `resgate_realizado — ${refId || ""}`.trim(),
      });

      // Post-create dedup: se dois requests concorrentes criaram transações com a mesma chave,
      // remove as duplicatas mantendo apenas a primeira
      const afterResgate = await base44.asServiceRole.entities.PointTransaction.filter({ chave_idempotencia: chave });
      if (afterResgate.length > 1) {
        // P0 residual: deterministic tiebreaker (created_date + id) — concurrent requests
        // must agree on the single survivor, otherwise both delete each other and both increment.
        const sorted = [...afterResgate].sort(deterministicCompare);
        const duplicates = sorted.slice(1);
        const isMyTxDuplicate = duplicates.some((d) => d.id === resgateTx.id);
        // P0 residual: idempotent deletes — a concurrent request may have already
        // deleted this duplicate; the survivor must still reach the return below.
        for (const dup of duplicates) {
          try { await base44.asServiceRole.entities.PointTransaction.delete(dup.id); } catch {}
        }
        if (isMyTxDuplicate) {
          return Response.json({ credited: false, pontos: 0, reason: "limit_reached" });
        }
      }
      return Response.json({ credited: false, pontos: 0, reason: "resgate_no_points" });
    }

    // 1. Buscar regra ativa
    const rules = await base44.asServiceRole.entities.ScoringRule.filter({
      event_id: eventId, acao, ativo: true, is_deleted: false,
    });
    if (!rules || rules.length === 0) {
      return Response.json({ credited: false, pontos: 0, reason: "no_rule" });
    }
    const rule = rules[0];

    // 2. Montar chave de idempotência
    const chave = buildIdempotencyKey({ eventId, participantId, acao, refId, limiteTipo: rule.limite_tipo });

    // 3. Verificar duplicata (fresh, server-side — race window minimizada)
    const existing = await base44.asServiceRole.entities.PointTransaction.filter({ chave_idempotencia: chave });
    if (existing && existing.length >= (rule.limite_valor || 1)) {
      return Response.json({ credited: false, pontos: 0, reason: "limit_reached" });
    }

    // 4. Registrar transação (incrementa apenas se sobreviver ao dedup abaixo)
    const tx = await base44.asServiceRole.entities.PointTransaction.create({
      event_id: eventId,
      participant_id: participantId,
      person_id: personId || undefined,
      acao,
      scoring_rule_id: rule.id,
      pontos: rule.pontos,
      chave_idempotencia: chave,
      ref_id: refId || undefined,
      descricao: `${acao} — ${refId || ""}`.trim(),
    });

    // 5. Post-create idempotency check: se dois requests concorrentes criaram
    // transações com a mesma chave, remove as duplicatas e reverte incrementos
    const afterCreate = await base44.asServiceRole.entities.PointTransaction.filter({ chave_idempotencia: chave });
    const limit = rule.limite_valor || 1;
    const myTxStillExists = afterCreate.some((t) => t.id === tx.id);
    if (!myTxStillExists) {
      // Nossa transação foi deletada pelo dedup de outro request concorrente
      return Response.json({ credited: false, pontos: 0, reason: "limit_reached" });
    }
    if (afterCreate.length > limit) {
      // P0 residual: deterministic tiebreaker (created_date + id) — concurrent requests
      // must agree on the single survivor, otherwise both delete each other and both increment.
      const sorted = [...afterCreate].sort(deterministicCompare);
      const duplicates = sorted.slice(limit);
      const isMyTxDuplicate = duplicates.some((d) => d.id === tx.id);
      // P0 residual: idempotent deletes — a concurrent request may have already
      // deleted this duplicate; the survivor must still reach the increment below.
      for (const dup of duplicates) {
        try { await base44.asServiceRole.entities.PointTransaction.delete(dup.id); } catch {}
      }
      if (isMyTxDuplicate) {
        return Response.json({ credited: false, pontos: 0, reason: "limit_reached" });
      }
    }

    // 6. ATOMIC increment — only if survived dedup
    await base44.asServiceRole.entities.Participant.updateMany(
      { id: participantId },
      { $inc: { points_total: rule.pontos } }
    );

    return Response.json({ credited: true, pontos: rule.pontos });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
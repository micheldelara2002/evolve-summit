/**
 * Motor de Pontuação — client-side
 * Lê ScoringRule do evento, verifica idempotência via PointTransaction,
 * credita pontos no Participant e registra PointTransaction.
 *
 * Uso:
 *   import { processAction } from "@/lib/scoringEngine";
 *   await processAction({ eventId, participantId, personId, acao: "presenca_sessao", refId: sessionId });
 */
import { base44 } from "@/api/base44Client";

/**
 * @param {object} params
 * @param {string} params.eventId
 * @param {string} params.participantId
 * @param {string} [params.personId]
 * @param {string} params.acao  — valor de ACAO_EVENTO_KEYS
 * @param {string} [params.refId] — ID de referência (session_id, etc.)
 * @returns {Promise<{ credited: boolean, pontos: number, reason?: string }>}
 */
export async function processAction({ eventId, participantId, personId, acao, refId = "" }) {
  if (!eventId || !participantId || !acao) return { credited: false, pontos: 0, reason: "params_missing" };

  // Resgate: cria PointTransaction com 0 pontos para badges, sem creditar pontos
  if (acao === "resgate_realizado") {
    const chave = `${eventId}:${participantId}:${acao}:${refId}`;
    const existing = await base44.entities.PointTransaction.filter({ chave_idempotencia: chave });
    if (existing && existing.length > 0) {
      return { credited: false, pontos: 0, reason: "limit_reached" };
    }
    await base44.entities.PointTransaction.create({
      event_id: eventId,
      participant_id: participantId,
      person_id: personId || undefined,
      acao,
      pontos: 0,
      chave_idempotencia: chave,
      ref_id: refId || undefined,
      descricao: `resgate_realizado — ${refId || ""}`.trim(),
    });
    return { credited: false, pontos: 0, reason: "resgate_no_points" };
  }

  // 1. Buscar regra ativa para esta ação no evento
  const rules = await base44.entities.ScoringRule.filter({ event_id: eventId, acao, ativo: true, is_deleted: false });
  if (!rules || rules.length === 0) return { credited: false, pontos: 0, reason: "no_rule" };
  const rule = rules[0];

  // 2. Montar chave de idempotência baseada no tipo de limite
  const chave = buildIdempotencyKey({ eventId, participantId, acao, refId, limiteTipo: rule.limite_tipo });

  // 3. Verificar duplicata
  const existing = await base44.entities.PointTransaction.filter({ chave_idempotencia: chave });
  if (existing && existing.length >= (rule.limite_valor || 1)) {
    return { credited: false, pontos: 0, reason: "limit_reached" };
  }

  // 4. Registrar transação
  await base44.entities.PointTransaction.create({
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

  // 5. Somar pontos no Participant (campo points_total)
  const participants = await base44.entities.Participant.filter({ id: participantId });
  if (participants && participants.length > 0) {
    const p = participants[0];
    const current = p.points_total ?? p.points ?? 0;
    await base44.entities.Participant.update(participantId, {
      points_total: current + rule.pontos,
      points: current + rule.pontos, // manter campo legado em sincronia
    });
  }

  return { credited: true, pontos: rule.pontos };
}

function buildIdempotencyKey({ eventId, participantId, acao, refId, limiteTipo }) {
  switch (limiteTipo) {
    case "one_shot":
      // só uma vez por participante+acao no evento
      return `${eventId}:${participantId}:${acao}`;
    case "por_sessao":
    case "por_estande":
      // uma vez por sessão/estande
      return `${eventId}:${participantId}:${acao}:${refId}`;
    case "por_par_usuarios":
      // chave por par — refId deve ser o outro participantId ordenado
      return `${eventId}:${acao}:${[participantId, refId].sort().join(":")}`;
    default:
      return `${eventId}:${participantId}:${acao}:${refId}`;
  }
}
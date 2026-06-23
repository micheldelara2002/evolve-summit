/**
 * Motor de Badges — avalia se uma badge foi desbloqueada com base
 * nas transações de pontos do participante.
 *
 * Critérios suportados:
 * - first: primeira ocorrência da ação (threshold = 1)
 * - count: quantidade de ocorrências >= valor_meta
 * - points_total: soma de pontos >= valor_meta
 */
export function isBadgeUnlocked(badge, transactions) {
  if (!badge?.criterio_tipo || !badge?.acao_referencia) return false;
  const relevant = (transactions || []).filter((t) => t.acao === badge.acao_referencia);

  if (badge.criterio_tipo === "first") return relevant.length >= 1;
  if (badge.criterio_tipo === "count") return relevant.length >= (badge.valor_meta || 1);
  if (badge.criterio_tipo === "points_total") {
    const total = (transactions || []).reduce((s, t) => s + (t.pontos || 0), 0);
    return total >= (badge.valor_meta || 0);
  }
  return false;
}
/**
 * awardUtils — helpers de parsing/cálculo para o módulo de premiação.
 */

export function parseCriteria(criteriaConfig) {
  try {
    const arr = JSON.parse(criteriaConfig || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function parseScores(scoresStr) {
  try {
    const obj = JSON.parse(scoresStr || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

export function criteriaTotal(scores, criteria) {
  const s = scores || {};
  let total = 0;
  for (const c of criteria) {
    total += Number(s[c.id] ?? 0) * (c.weight || 1);
  }
  return Math.round(total * 100) / 100;
}

export function criteriaMaxTotal(criteria) {
  return criteria.reduce((sum, c) => sum + (c.max_score || 0) * (c.weight || 1), 0);
}
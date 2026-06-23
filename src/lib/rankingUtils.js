/**
 * Utilitários de Ranking — cálculos compartilhados para rankings de
 * participantes, palestrantes e sessões.
 */

/** Normaliza rating 1..5 para escala 0..10. */
export function normalizeRating(rating) {
  return (rating || 0) * 2;
}

/**
 * Constrói ranking de participantes por pontos.
 * @param {Array} participants — lista de Participant
 * @param {Array} persons — lista de Person (para fotos)
 * @param {string|null} eventId — se null, ranking geral; se informado, por evento
 * @returns {Array} ranking ordenado com posição
 */
export function buildParticipantRanking(participants, persons, eventId) {
  const personMap = new Map((persons || []).map((p) => [p.id, p]));
  const filtered = (participants || []).filter((p) => !p.is_deleted);

  // Agrupar por person_id (dedup de múltiplos papéis no mesmo evento)
  const byPerson = new Map();
  for (const p of filtered) {
    const key = p.person_id || `email:${p.email}`;
    if (!key) continue;
    const existing = byPerson.get(key);
    if (!existing) {
      byPerson.set(key, {
        personId: key,
        name: p.full_name,
        photoUrl: personMap.get(p.person_id)?.photo_url || null,
        points: p.points_total || 0,
        lastScoreAt: p.updated_date || null,
      });
    } else {
      if (eventId) {
        existing.points = Math.max(existing.points, p.points_total || 0);
      } else {
        existing.points += p.points_total || 0;
      }
      const pDate = p.updated_date ? new Date(p.updated_date).getTime() : 0;
      const eDate = existing.lastScoreAt ? new Date(existing.lastScoreAt).getTime() : 0;
      if (pDate > eDate) existing.lastScoreAt = p.updated_date;
    }
  }

  const ranking = [...byPerson.values()]
    .filter((p) => p.points >= 1)
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const aTime = a.lastScoreAt ? new Date(a.lastScoreAt).getTime() : Infinity;
      const bTime = b.lastScoreAt ? new Date(b.lastScoreAt).getTime() : Infinity;
      if (aTime !== bTime) return aTime - bTime;
      return (a.name || "").localeCompare(b.name || "");
    });

  ranking.forEach((p, i) => { p.position = i + 1; });
  return ranking;
}

/**
 * Calcula métricas de avaliação por sessão.
 * @param {Array} sessions
 * @param {Array} reviews — SessionReview
 * @param {Array} attendances — SessionAttendance
 * @returns {Array} métricas por sessão
 */
export function buildSessionMetrics(sessions, reviews, attendances) {
  return (sessions || []).map((session) => {
    const sReviews = (reviews || []).filter((r) => r.session_id === session.id);
    const sAttendances = (attendances || []).filter((a) => a.session_id === session.id && a.is_present);

    const reviewCount = sReviews.length;
    const presenceCount = sAttendances.length;
    const rawAvg = reviewCount > 0
      ? sReviews.reduce((s, r) => s + (r.rating || 0), 0) / reviewCount
      : 0;
    const avgRating = normalizeRating(rawAvg);
    const evaluationRate = presenceCount > 0 ? reviewCount / presenceCount : 0;
    const weightedScore = avgRating * evaluationRate;

    return {
      session,
      avgRating,
      reviewCount,
      presenceCount,
      evaluationRate,
      weightedScore,
      isObservable: reviewCount < 5,
    };
  });
}
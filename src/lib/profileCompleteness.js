/**
 * Cálculo de completude do perfil com base nos campos editáveis de participant.
 * Preparado para futura integração com badge de completude (sem disparo nesta fase).
 */

// Campos editáveis considerados no cálculo
export const COMPLETENESS_FIELDS = [
  "phone",
  "company",
  "job_title",
  "bio",
  "linkedin",
  "instagram",
  "website",
  "youtube",
];

/** Retorna true se o valor conta como preenchido */
function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/** Calcula percentual de completude (0–100, inteiro) */
export function calcCompleteness(participant) {
  if (!participant) return 0;
  const filled = COMPLETENESS_FIELDS.filter((f) => isFilled(participant[f])).length;
  return Math.round((filled / COMPLETENESS_FIELDS.length) * 100);
}

/**
 * Stub para futura integração de badge de completude.
 * Recebe o participant atualizado e a lista de eventos ativos.
 * Quando ativado, deve checar se o score atingiu o target da badge
 * e atribuir a badge apenas em eventos com status "active".
 *
 * @param {object} participant
 * @param {Array}  activeEvents  — eventos com status === "active"
 */
export async function maybeAwardCompletenessBadge(participant, activeEvents) {
  // TODO: implementar quando o motor de badges estiver pronto.
  // Regras:
  //   - apenas eventos com status "active" são elegíveis
  //   - ignorar draft, finished, cancelled
  //   - se completude >= target (ex: 100%), atribuir badge em todos os eventos elegíveis
  return;
}
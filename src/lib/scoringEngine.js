/**
 * Motor de Pontuação — delega para backend function (processScoringAction).
 * O backend garante:
 * - Idempotência via chave_idempotencia (check-then-create server-side)
 * - Incremento atômico de points_total via $inc (elimina lost updates)
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

  try {
    const response = await base44.functions.invoke('processScoringAction', {
      eventId, participantId, personId, acao, refId,
    });
    return response.data;
  } catch (err) {
    return { credited: false, pontos: 0, reason: "error" };
  }
}
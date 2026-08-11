import { base44 } from "@/api/base44Client";

/**
 * roleEngine — utilitário central de consulta de papéis (EventMembership).
 *
 * Separa PERMISSÃO (EventMembership) de PRESENÇA (Participant).
 * Toda verificação de papel administrativo no app deve passar por aqui,
 * garantindo que a fonte da verdade seja sempre a EventMembership.
 */

// ── Consultas ────────────────────────────────────────────────────────────

/**
 * Busca todos os vínculos ativos do usuário atual em todos os eventos.
 * @param {string} userId — user.id do usuário logado
 * @returns {Promise<Array>} EventMembership[] ativos
 */
export async function getMyMemberships(userId) {
  if (!userId) return [];
  return await base44.entities.EventMembership.filter({
    user_id: userId,
    is_active: true,
    is_deleted: false,
  });
}

/**
 * Busca vínculos de uma pessoa em um evento específico (todos os papéis dela ali).
 * @param {string} eventId
 * @param {string} personId
 * @returns {Promise<Array>} EventMembership[]
 */
export async function getEventMemberships(eventId, personId) {
  if (!eventId || !personId) return [];
  return await base44.entities.EventMembership.filter({
    event_id: eventId,
    person_id: personId,
    is_deleted: false,
  });
}

/**
 * Busca todos os vínculos de um evento (para telas administrativas).
 * @param {string} eventId
 * @returns {Promise<Array>} EventMembership[]
 */
export async function getEventMembers(eventId) {
  if (!eventId) return [];
  return await base44.entities.EventMembership.filter({
    event_id: eventId,
    is_deleted: false,
  });
}

// ── Helpers de checagem (operam sobre arrays já carregados) ──────────────

export function hasRole(memberships, role) {
  return Array.isArray(memberships) && memberships.some((m) => m.role === role && m.is_active !== false);
}

export function hasAnyRole(memberships, roles) {
  return Array.isArray(memberships) && memberships.some((m) => roles.includes(m.role) && m.is_active !== false);
}

/**
 * Retorna os eventos (event_id únicos) onde o usuário tem determinado papel.
 */
export function getEventIdsForRole(memberships, role) {
  const ids = (memberships || [])
    .filter((m) => m.role === role && m.is_active !== false)
    .map((m) => m.event_id);
  return [...new Set(ids)];
}

/**
 * Verifica papel em um evento específico (síncrono, sobre array carregado).
 */
export function hasRoleInEvent(memberships, eventId, role) {
  return Array.isArray(memberships) && memberships.some(
    (m) => m.event_id === eventId && m.role === role && m.is_active !== false
  );
}

// ── Mapeamento de papéis para labels/ícones (compartilhado) ───────────────

export const EVENT_ROLES = [
  { value: "attendee", label: "Participante" },
  { value: "speaker", label: "Palestrante" },
  { value: "team", label: "Equipe" },
  { value: "manager", label: "Gerente" },
  { value: "partner_rep", label: "Rep. Parceiro" },
  { value: "reviewer", label: "Avaliador" },
  { value: "curator", label: "Curador" },
  { value: "entrant", label: "Candidato" },
  { value: "winner", label: "Premiado" },
];

// ── Checagens async (consultam EventMembership diretamente) ────────────

/**
 * Verifica se o usuário é curador de um evento específico.
 * O curador revisa submissões CFP do evento sem precisar ser participante.
 * @param {object} user — usuário logado
 * @param {string} eventId
 * @returns {Promise<boolean>}
 */
export async function isCurator(user, eventId) {
  if (!user?.id || !eventId) return false;
  try {
    const memberships = await base44.entities.EventMembership.filter({
      user_id: user.id,
      event_id: eventId,
      role: "curator",
      is_active: true,
      is_deleted: false,
    });
    return memberships.length > 0;
  } catch {
    return false;
  }
}

export function roleLabel(role) {
  return EVENT_ROLES.find((r) => r.value === role)?.label ?? role;
}
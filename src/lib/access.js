import { base44 } from "@/api/base44Client";

// ── Admin ───────────────────────────────────────────────────────
export function isAdmin(user) {
  return user?.role === "admin";
}

// ── Event access ────────────────────────────────────────────────
// P3 (2026-09-29) — canManageEvent removido: regra morta e contraditória
// (a true o app todo aceita manager/team via EventMembership; ver
// useEventAccess/EventManageRoute).
export function filterEventsByAccess(events, user, managedEventIds = new Set()) {
  if (isAdmin(user)) return events;
  // Não-admin: apenas eventos com EventMembership ativa de gestão (manager/team).
  return events.filter((e) => managedEventIds.has(e.id));
}

// ── Partner access helpers ──────────────────────────────────────
// A permissão de parceiro vem de PartnerRepresentative (role_in_partner),
// não mais de User.role. Os reps do usuário logado são anexados ao
// objeto user em AuthContext (user.partner_reps) para checagem
// síncrona em navs/guards.

export function isPartnerManager(user) {
  return (user?.partner_reps || []).some(
    (r) => r.is_active && r.role_in_partner === "partner_manager"
  );
}

// P3 (2026-09-29) — isRepresentative removido (export morto; a checagem de
// escopo de parceiro usa canManagePartner/isPartnerManager).
export function canAccessPartnerAdmin(user) {
  return isAdmin(user) || isPartnerManager(user);
}

/**
 * Carrega os PartnerRepresentative ativos do usuário (por user_id e/ou
 * person_id, resolvendo person por e-mail quando necessário). Usado pelo
 * AuthContext para popular user.partner_reps no login.
 */
export async function loadPartnerReps(user) {
  if (!user?.id) return [];
  try {
    const res = await base44.functions.invoke('getMyPartnerReps', {});
    return res.data?.partnerReps || [];
  } catch {
    return [];
  }
}

/**
 * Filtra a lista de partners pelo escopo do usuário.
 * admin → todos; partner_manager → apenas partners onde é gestor.
 */
export function filterPartnersByAccess(partners, user, reps = []) {
  if (isAdmin(user)) return partners;
  if (!isPartnerManager(user)) return [];
  const list = reps.length ? reps : user?.partner_reps || [];
  const allowed = new Set(
    list
      .filter((r) => r.is_active && r.role_in_partner === "partner_manager")
      .map((r) => r.partner_id)
  );
  return partners.filter((p) => allowed.has(p.id));
}

export function canManagePartner(user, partnerId, reps = []) {
  if (isAdmin(user)) return true;
  const list = reps.length ? reps : user?.partner_reps || [];
  return list.some(
    (r) =>
      r.partner_id === partnerId &&
      r.role_in_partner === "partner_manager" &&
      r.is_active
  );
}

/**
 * Busca todos os vínculos ativos (EventMembership) do usuário em todos os
 * eventos. P2/P3 (2026-09-29) — consolidado do extinto lib/roleEngine.js
 * (único export vivo do arquivo); separa PERMISSÃO (EventMembership) de
 * PRESENÇA (Participant).
 */
export async function getMyMemberships(userId) {
  if (!userId) return [];
  return await base44.entities.EventMembership.filter({
    user_id: userId,
    is_active: true,
    is_deleted: false,
  });
}
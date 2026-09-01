import { base44 } from "@/api/base44Client";

// ── Admin ───────────────────────────────────────────────────────
export function isAdmin(user) {
  return user?.role === "admin";
}

// ── Event access ────────────────────────────────────────────────
// Hoje o gerenciamento de evento é exclusivo do admin. O branch
// "manager"/managed_event_ids era legado e nunca era atribuído (o
// enum de User nem continha "manager"), então foi removido.
export function canManageEvent(user, eventId) {
  return isAdmin(user);
}

export function filterEventsByAccess(events, user) {
  if (isAdmin(user)) return events;
  return events.filter((e) => e.manager_id === user?.id);
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

export function isRepresentative(user) {
  return (user?.partner_reps || []).some(
    (r) => r.is_active && r.role_in_partner === "representative"
  );
}

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
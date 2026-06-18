export function isAdmin(user) {
  return user?.role === "admin";
}

export function canManageEvent(user, eventId) {
  if (isAdmin(user)) return true;
  if (user?.role === "manager") {
    const managedIds = user?.managed_event_ids || [];
    return managedIds.includes(eventId);
  }
  return false;
}

export function getEventFilter(user) {
  if (isAdmin(user)) return {};
  return {};
}

export function filterEventsByAccess(events, user) {
  if (isAdmin(user)) return events;
  const managedIds = user?.managed_event_ids || [];
  return events.filter(
    (e) => managedIds.includes(e.id) || e.manager_id === user?.id
  );
}

// ────────────────────────────────────────────────────────────────
// Partner access helpers
// ────────────────────────────────────────────────────────────────

export function isPartnerManager(user) {
  return user?.role === "partner_manager";
}

/**
 * Filtra a lista de partners pelo escopo do usuário.
 * admin → todos; partner_manager → apenas partners vinculados via reps.
 * @param {Array} partners
 * @param {object} user
 * @param {Array} reps  — PartnerRepresentative[] do usuário (já filtrados por user_id/person_id)
 */
export function filterPartnersByAccess(partners, user, reps = []) {
  if (isAdmin(user)) return partners;
  if (isPartnerManager(user)) {
    const allowed = new Set(
      reps
        .filter((r) => r.is_active && !r.is_deleted && r.role_in_partner === "partner_manager")
        .map((r) => r.partner_id)
    );
    return partners.filter((p) => allowed.has(p.id));
  }
  return [];
}

export function canManagePartner(user, partnerId, reps = []) {
  if (isAdmin(user)) return true;
  if (isPartnerManager(user)) {
    return reps.some(
      (r) =>
        r.partner_id === partnerId &&
        r.role_in_partner === "partner_manager" &&
        r.is_active &&
        !r.is_deleted
    );
  }
  return false;
}
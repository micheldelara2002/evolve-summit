// P0.2 — Shared event-scoped authorization helper.
// Replaces global role checks (user.role === 'manager') with event-scoped
// EventMembership verification. Global admins always pass.
//
// Import pattern (from a function entry.ts):
//   import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

export const EVENT_MANAGER_ROLES = ['manager', 'team'];
export const EVENT_CURATOR_ROLES = ['curator'];

/**
 * Verifies that the user has an active EventMembership with one of the allowed
 * roles for the specified event. Global admins always pass.
 *
 * @returns {Promise<{ authorized: boolean, membership?: object }>}
 */
export async function verifyEventMembership(base44, user, eventId, allowedRoles) {
  if (!user) return { authorized: false };
  if (user.role === 'admin') return { authorized: true };
  if (!eventId) return { authorized: false };

  const memberships = await base44.asServiceRole.entities.EventMembership.filter({
    event_id: eventId,
    user_id: user.id,
    is_active: true,
    is_deleted: false,
    role: { $in: allowedRoles },
  });

  return { authorized: memberships.length > 0, membership: memberships[0] };
}

/**
 * Verifies that the user has ANY active EventMembership for the specified event
 * (any role). Global admins always pass. Used for partner/speaker-scoped actions
 * where the specific role matters less than having a legitimate tie to the event.
 */
export async function verifyAnyEventMembership(base44, user, eventId) {
  if (!user) return { authorized: false };
  if (user.role === 'admin') return { authorized: true };
  if (!eventId) return { authorized: false };

  const memberships = await base44.asServiceRole.entities.EventMembership.filter({
    event_id: eventId,
    user_id: user.id,
    is_active: true,
    is_deleted: false,
  });

  return { authorized: memberships.length > 0, membership: memberships[0] };
}
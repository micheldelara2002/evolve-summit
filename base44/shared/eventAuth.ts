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

/**
 * Resolve o person_id do usuário autenticado a partir do e-mail (Person.contact_email).
 * Usado para autorização cross-entidade (Participant por person_id, PartnerRepresentative por person_id).
 */
export async function resolveUserPersonId(base44, user) {
  if (!user?.email) return null;
  try {
    const persons = await base44.asServiceRole.entities.Person.filter({
      contact_email: user.email,
      is_active: true,
    });
    return persons?.[0]?.id || null;
  } catch {
    return null;
  }
}

/**
 * Autorização de leitura/escrita de dados de um evento (Lote 1 RLS):
 * admin, OU qualquer EventMembership ativa no evento, OU Participant ativo
 * (não cancelado) vinculado ao usuário por e-mail ou person_id.
 * Cobre participantes (attendee), palestrantes, parceiros, gestores e time.
 */
export async function canAccessEventData(base44, user, eventId) {
  if (!user || !eventId) return false;
  if (user.role === 'admin') return true;

  const memberships = await base44.asServiceRole.entities.EventMembership.filter({
    event_id: eventId,
    user_id: user.id,
    is_active: true,
    is_deleted: false,
  });
  if (memberships.length > 0) return true;

  const personId = await resolveUserPersonId(base44, user);
  const queries = [
    base44.asServiceRole.entities.Participant.filter({
      event_id: eventId,
      email: user.email,
      is_deleted: false,
      registration_status: { $ne: 'cancelled' },
    }),
  ];
  if (personId) {
    queries.push(
      base44.asServiceRole.entities.Participant.filter({
        event_id: eventId,
        person_id: personId,
        is_deleted: false,
        registration_status: { $ne: 'cancelled' },
      })
    );
  }
  const [byEmail, byPerson] = await Promise.all(queries);
  return (byEmail?.length > 0) || (byPerson?.length > 0);
}

/**
 * Autorização de leitura de dados de um parceiro (cross-evento):
 * admin, OU PartnerRepresentative ativo do partnerId (por user_id ou person_id).
 */
export async function canAccessPartnerData(base44, user, partnerId) {
  if (!user || !partnerId) return false;
  if (user.role === 'admin') return true;

  const personId = await resolveUserPersonId(base44, user);
  const queries = [
    base44.asServiceRole.entities.PartnerRepresentative.filter({
      partner_id: partnerId,
      user_id: user.id,
      is_active: true,
      is_deleted: false,
    }),
  ];
  if (personId) {
    queries.push(
      base44.asServiceRole.entities.PartnerRepresentative.filter({
        partner_id: partnerId,
        person_id: personId,
        is_active: true,
        is_deleted: false,
      })
    );
  }
  const [byUser, byPerson] = await Promise.all(queries);
  return (byUser?.length > 0) || (byPerson?.length > 0);
}

/**
 * Autorização de GESTÃO de um parceiro (Lote 2):
 * admin, OU PartnerRepresentative ativo com role_in_partner 'partner_manager'
 * vinculado por user_id ou person_id. Usada por savePartner/savePartnerRep/
 * getManagedPartners para validar que o chamador pode editar a empresa e seus reps.
 */
export async function canManagePartnerData(base44, user, partnerId) {
  if (!user || !partnerId) return false;
  if (user.role === 'admin') return true;

  const personId = await resolveUserPersonId(base44, user);
  const queries = [
    base44.asServiceRole.entities.PartnerRepresentative.filter({
      partner_id: partnerId,
      user_id: user.id,
      is_active: true,
      is_deleted: false,
      role_in_partner: 'partner_manager',
    }),
  ];
  if (personId) {
    queries.push(
      base44.asServiceRole.entities.PartnerRepresentative.filter({
        partner_id: partnerId,
        person_id: personId,
        is_active: true,
        is_deleted: false,
        role_in_partner: 'partner_manager',
      })
    );
  }
  const [byUser, byPerson] = await Promise.all(queries);
  return (byUser?.length > 0) || (byPerson?.length > 0);
}

/**
 * Resolve os partner_ids que o usuário gerencia como partner_manager (Lote 2).
 * Usado por getManagedPartners para escopar a lista de empresas.
 */
export async function resolveUserPartnerManagerIds(base44, user) {
  if (!user) return [];
  const personId = await resolveUserPersonId(base44, user);
  const queries = [
    base44.asServiceRole.entities.PartnerRepresentative.filter({
      user_id: user.id,
      is_active: true,
      is_deleted: false,
      role_in_partner: 'partner_manager',
    }),
  ];
  if (personId) {
    queries.push(
      base44.asServiceRole.entities.PartnerRepresentative.filter({
        person_id: personId,
        is_active: true,
        is_deleted: false,
        role_in_partner: 'partner_manager',
      })
    );
  }
  const [byUser, byPerson] = await Promise.all(queries);
  const ids = new Set();
  for (const r of [...(byUser || []), ...(byPerson || [])]) if (r.partner_id) ids.add(r.partner_id);
  return [...ids];
}
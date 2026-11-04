// P0.2 — Shared event-scoped authorization helper.
// Replaces global role checks (user.role === 'manager') with event-scoped
// EventMembership verification. Global admins always pass.
//
// Import pattern (from a function entry.ts):
//   import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

import { resolveIdentity, findMyParticipants, identityOwnsParticipant } from "./identity.ts";

export const EVENT_MANAGER_ROLES = ['manager', 'team'];
// Papel FINANCEIRO do evento (2026-09-29): comércio (preços/lotes/cupons),
// relatórios financeiros, estornos e retry de emissão são exclusivos do
// GERENTE (+admin). O 'team' mantém apenas o operacional (check-ins,
// participantes, trilhas, certificados, avaliações, sorteios do evento).
export const EVENT_FINANCE_ROLES = ['manager'];
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
// P1-A (2026-11-04) — a resolução de identidade tem UMA implementação:
// shared/identity.ts (precedência vínculo explícito > e-mail normalizado >
// nenhum, e ambiguidade = negação). Este export é mantido para os chamadores
// existentes e delega para ela.
export async function resolveUserPersonId(base44, user) {
  const identity = await resolveIdentity(base44, user);
  return identity.selfPersonId || null;
}

/** Conjunto verificado de person_ids do usuário (posse: "isto é meu?"). */
export async function resolveUserPersonIds(base44, user) {
  const identity = await resolveIdentity(base44, user);
  return identity.personIds;
}

/**
 * Sorteio do PALESTRANTE (2026-09-29): autoriza sorteios escopados às PRÓPRIAS
 * sessões do palestrante. Exige membership ativa com papel 'speaker' no evento
 * E que o participant_id informado (context_ref_id) pertença ao próprio usuário
 * (person_id ou e-mail). Gestores (manager/team) e admin sempre passam.
 */
export async function verifyOwnSpeakerScope(base44, user, eventId, participantId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!eventId || !participantId) return false;

  const spk = await verifyEventMembership(base44, user, eventId, ['speaker']);
  if (!spk.authorized) return false;

  const parts = await base44.asServiceRole.entities.Participant.filter({
    id: participantId,
    event_id: eventId,
    is_deleted: false,
  });
  if (!parts?.length) return false;
  const part = parts[0];
  // P1-A — posse avaliada pelo conjunto verificado (vínculo + e-mails
  // normalizados), nunca por um único person_id escolhido.
  const identity = await resolveIdentity(base44, user);
  return identityOwnsParticipant(identity, part);
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

  // P2 — Membership e identidade são independentes: consultadas em paralelo em
  // vez de sequencialmente. P1-A — Participants resolvidos pelo conjunto
  // verificado (person_ids + e-mails normalizados), com consultas direcionadas.
  const [memberships, identity] = await Promise.all([
    base44.asServiceRole.entities.EventMembership.filter({
      event_id: eventId,
      user_id: user.id,
      is_active: true,
      is_deleted: false,
    }),
    resolveIdentity(base44, user),
  ]);
  if (memberships.length > 0) return true;

  const mine = await findMyParticipants(base44, identity, eventId, {
    registration_status: { $ne: 'cancelled' },
  });
  return mine.length > 0;
}

/**
 * Autorização de leitura de dados de um parceiro (cross-evento):
 * admin, OU PartnerRepresentative ativo do partnerId (por user_id ou person_id).
 */
export async function canAccessPartnerData(base44, user, partnerId) {
  if (!user || !partnerId) return false;
  if (user.role === 'admin') return true;

  const identity = await resolveIdentity(base44, user);
  const queries = [
    base44.asServiceRole.entities.PartnerRepresentative.filter({
      partner_id: partnerId,
      user_id: user.id,
      is_active: true,
      is_deleted: false,
    }),
  ];
  if (identity.personIds.length > 0) {
    queries.push(
      base44.asServiceRole.entities.PartnerRepresentative.filter({
        partner_id: partnerId,
        person_id: { $in: identity.personIds },
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

  const identity = await resolveIdentity(base44, user);
  const queries = [
    base44.asServiceRole.entities.PartnerRepresentative.filter({
      partner_id: partnerId,
      user_id: user.id,
      is_active: true,
      is_deleted: false,
      role_in_partner: 'partner_manager',
    }),
  ];
  if (identity.personIds.length > 0) {
    queries.push(
      base44.asServiceRole.entities.PartnerRepresentative.filter({
        partner_id: partnerId,
        person_id: { $in: identity.personIds },
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
 * AUD-010 (2026-10-02) — Resolve os partner_ids em que o usuário tem vínculo
 * ativo de representante, por user_id ou person_id. Unificação: as duas
 * variantes anteriores (qualquer papel vs. apenas partner_manager) duplicavam
 * toda a lógica de consulta em paralelo, diferindo só no filtro de papel —
 * agora um único caminho recebe o filtro opcional.
 * Usado para escopar sorteios/histórico de parceiro (sem filtro) e a lista de
 * empresas gerenciadas (com 'partner_manager').
 */
export async function resolveUserPartnerIds(base44, user, roleInPartner = undefined) {
  if (!user) return [];
  const identity = await resolveIdentity(base44, user);
  const scope = roleInPartner ? { role_in_partner: roleInPartner } : {};
  const queries = [
    base44.asServiceRole.entities.PartnerRepresentative.filter({
      user_id: user.id,
      is_active: true,
      is_deleted: false,
      ...scope,
    }),
  ];
  if (identity.personIds.length > 0) {
    queries.push(
      base44.asServiceRole.entities.PartnerRepresentative.filter({
        person_id: { $in: identity.personIds },
        is_active: true,
        is_deleted: false,
        ...scope,
      })
    );
  }
  const [byUser, byPerson] = await Promise.all(queries);
  const ids = new Set();
  for (const r of [...(byUser || []), ...(byPerson || [])]) if (r.partner_id) ids.add(r.partner_id);
  return [...ids];
}

/**
 * Resolve os partner_ids que o usuário gerencia como partner_manager (Lote 2).
 * Usado por getManagedPartners para escopar a lista de empresas.
 */
export async function resolveUserPartnerManagerIds(base44, user) {
  return resolveUserPartnerIds(base44, user, 'partner_manager');
}
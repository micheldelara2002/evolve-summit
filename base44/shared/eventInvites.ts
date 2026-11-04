// 2026-11-04 — CONVITE + VÍNCULO DE PAPEL NO EVENTO (única implementação).
//
// O admin fecha o contrato, cadastra o evento e informa o e-mail do gerente. Se
// a pessoa já usa o app, o vínculo nasce na hora; se não, o convite fica
// pendente e é convertido em vínculo no primeiro acesso (linkPendingInvites,
// chamado pelo getOrCreatePerson depois de confirmar User.person_id).
//
// O mesmo mecanismo serve ao futuro convite em lote de participantes importados:
// o papel concedido é parâmetro (target_role), não um caminho separado.

import { normalizeEmail, emailMatchVariants } from "./identity.ts";
import { inviteAccount } from "./accountInvites.ts";

export type GrantResult =
  | { status: "linked"; userId: string; personId: string; membership: any }
  | { status: "invited"; invite: any; invited: boolean; inviteError: string };

function svcOf(client: any): any {
  return client && client.asServiceRole ? client.asServiceRole : client;
}

async function ensurePersonForUser(svc: any, user: any, displayName?: string): Promise<string> {
  const emailNorm = normalizeEmail(user.email);

  if (user.person_id) {
    const linked = await svc.entities.Person.filter({ id: user.person_id });
    if (linked?.[0]?.id) return linked[0].id;
  }

  const candidates = await svc.entities.Person.filter({
    contact_email: { $in: emailMatchVariants(user.email) },
    is_active: { $ne: false },
  });
  const matches = (candidates || []).filter(
    (p: any) => p?.id && normalizeEmail(p.contact_email) === emailNorm,
  );
  if (matches.length > 1) {
    // Ambiguidade nunca é resolvida "pegando a primeira".
    throw new Error("identity_ambiguous");
  }

  let personId = matches[0]?.id || null;
  if (!personId) {
    const created = await svc.entities.Person.create({
      full_name: displayName || user.full_name || "Novo Usuário",
      contact_email: emailNorm,
      is_active: true,
      created_day: new Date().toISOString().slice(0, 10),
    });
    if (!created?.id) throw new Error("person_not_created");
    personId = created.id;
  }

  await svc.entities.User.update(user.id, { person_id: personId });
  const confirmed = await svc.entities.User.filter({ id: user.id });
  if (confirmed?.[0]?.person_id !== personId) throw new Error("link_not_persisted");
  return personId;
}

async function ensureMembership(
  svc: any,
  { eventId, userId, personId, personName, userEmail, role }: any,
): Promise<any> {
  const existing = await svc.entities.EventMembership.filter({
    event_id: eventId,
    user_id: userId,
    role,
    is_deleted: false,
  });
  if (existing?.[0]) {
    if (existing[0].is_active === false) {
      return await svc.entities.EventMembership.update(existing[0].id, { is_active: true, person_id: personId });
    }
    return existing[0];
  }
  return await svc.entities.EventMembership.create({
    event_id: eventId,
    person_id: personId,
    person_name: personName || "",
    user_id: userId,
    user_email: normalizeEmail(userEmail),
    role,
    is_active: true,
    is_deleted: false,
  });
}

// Papéis de GESTÃO que também existem como presença no evento (Participant).
// 'attendee' nunca é criado aqui (a inscrição já nasceu antes do convite).
const ROLE_TO_PARTICIPANT: Record<string, string> = {
  team: "team",
  manager: "manager",
  attendee: "attendee",
};

/**
 * Garante a presença (Participant) de um papel de gestão. Idempotente por
 * person_id ou e-mail. É o que faz "estar no evento" virar participante no
 * momento em que a pessoa conclui o cadastro.
 */
async function ensureParticipantForRole(
  svc: any,
  { eventId, personId, role, personName, userEmail }: any,
): Promise<any | null> {
  const roleInEvent = ROLE_TO_PARTICIPANT[role];
  if (!roleInEvent) return null;
  const email = normalizeEmail(userEmail);

  const ors: any[] = [];
  if (personId) ors.push({ person_id: personId });
  if (email) ors.push({ email });
  if (ors.length === 0) return null;

  const existing = await svc.entities.Participant.filter({
    event_id: eventId,
    is_deleted: false,
    $or: ors,
  });
  const found = (existing || []).find(
    (p: any) => (personId && p.person_id === personId) || (email && normalizeEmail(p.email) === email),
  );

  if (found) {
    const needsUpdate = found.role_in_event !== roleInEvent || (personId && found.person_id !== personId);
    if (!needsUpdate) return found;
    return await svc.entities.Participant.update(found.id, {
      role_in_event: roleInEvent,
      ...(personId && !found.person_id ? { person_id: personId } : {}),
    });
  }

  // Só papéis de gestão criam presença a partir do convite.
  if (role !== "team" && role !== "manager") return null;

  return await svc.entities.Participant.create({
    event_id: eventId,
    full_name: personName || "",
    email,
    role_in_event: roleInEvent,
    registration_status: "confirmed",
    person_id: personId || "",
    is_deleted: false,
    created_day: new Date().toISOString().slice(0, 10),
  });
}

/**
 * Concede um papel de evento a um e-mail. Conta existente → vínculo imediato
 * (idempotente). Sem conta → convite pendente + e-mail de convite do app.
 */
export async function grantEventRole(
  client: any,
  { eventId, email, displayName, role = "manager", actor }: any,
): Promise<GrantResult> {
  const svc = svcOf(client);
  const emailNorm = normalizeEmail(email);
  if (!eventId || !emailNorm) throw new Error("missing_params");

  const events = await svc.entities.Event.filter({ id: eventId, is_deleted: false });
  const event = events?.[0];
  if (!event) throw new Error("event_not_found");

  const users = await svc.entities.User.filter({ email: { $in: emailMatchVariants(email) } });
  const target = (users || []).find((u: any) => normalizeEmail(u.email) === emailNorm) || (users || [])[0];

  if (target) {
    if (target.account_status === "deleted") throw new Error("account_deleted");
    const personId = await ensurePersonForUser(svc, target, displayName);
    const membership = await ensureMembership(svc, {
      eventId,
      userId: target.id,
      personId,
      personName: displayName || target.full_name || "",
      userEmail: target.email,
      role,
    });

    if (role === "manager") {
      await svc.entities.Event.update(eventId, {
        manager_id: target.id,
        manager_name: target.full_name || displayName || "",
      });
    }

    // Estar no evento com papel de gestão = ser participante.
    await ensureParticipantForRole(svc, {
      eventId,
      personId,
      role,
      personName: displayName || target.full_name || "",
      userEmail: target.email,
    });

    // Convites antigos para este e-mail passam a valer agora.
    await linkPendingInvites(client, { personId, userId: target.id, email: target.email });

    return { status: "linked", userId: target.id, personId, membership };
  }

  const pending = await svc.entities.EventInvite.filter({
    event_id: eventId,
    email: emailNorm,
    target_role: role,
    status: "pending",
    is_deleted: false,
  });
  let invite = pending?.[0];
  if (!invite) {
    invite = await svc.entities.EventInvite.create({
      event_id: eventId,
      email: emailNorm,
      invited_name: displayName || "",
      target_role: role,
      status: "pending",
      invited_by_user_id: actor?.id || "",
      invited_by_name: actor?.full_name || "",
      invite_sent_at: new Date().toISOString(),
      is_deleted: false,
    });
  }

  // Convite sai pelo client raiz (o de service role não tem o módulo `users`).
  const accountInvite = await inviteAccount(client, emailNorm);
  const invited = accountInvite.invited;
  const inviteError = accountInvite.error;
  if (invite?.id) {
    await svc.entities.EventInvite.update(invite.id, {
      invite_sent_at: new Date().toISOString(),
      invite_error: invited ? "" : inviteError,
    });
  }
  return { status: "invited", invite, invited, inviteError };
}

/**
 * Converte convites pendentes do e-mail em vínculos reais. Idempotente:
 * reexecutar não duplica membership nem reabre convite aceito.
 */
export async function linkPendingInvites(
  client: any,
  { personId, userId, email }: any,
): Promise<{ linked: number }> {
  const svc = svcOf(client);
  const emailNorm = normalizeEmail(email);
  if (!personId || !userId || !emailNorm) return { linked: 0 };

  const invites = await svc.entities.EventInvite.filter({
    email: { $in: emailMatchVariants(email) },
    status: "pending",
    is_deleted: false,
  });

  let linked = 0;
  for (const invite of invites || []) {
    if (!invite?.id || normalizeEmail(invite.email) !== emailNorm) continue;
    const events = await svc.entities.Event.filter({ id: invite.event_id, is_deleted: false });
    const event = events?.[0];
    if (!event) continue;

    const personRows = await svc.entities.Person.filter({ id: personId });
    const personName = personRows?.[0]?.full_name || "";

    // Participante (attendee) não precisa de membership: o acesso já vem do
    // Participant criado no cadastro. Membership é para papéis de GESTÃO.
    if ((invite.target_role || "manager") !== "attendee") {
      await ensureMembership(svc, {
        eventId: invite.event_id,
        userId,
        personId,
        personName,
        userEmail: email,
        role: invite.target_role || "manager",
      });
    }

    // Equipe/gerente convidados passam a existir como participantes do evento.
    await ensureParticipantForRole(svc, {
      eventId: invite.event_id,
      personId,
      role: invite.target_role || "manager",
      personName,
      userEmail: email,
    });

    if ((invite.target_role || "manager") === "manager" && !event.manager_id) {
      await svc.entities.Event.update(event.id, {
        manager_id: userId,
        manager_name: personName || "",
      });
    }

    await svc.entities.EventInvite.update(invite.id, {
      status: "accepted",
      accepted_at: new Date().toISOString(),
      accepted_user_id: userId,
    });
    linked += 1;
  }
  return { linked };
}

/**
 * 2026-11-04 — Vínculos de representante que esperavam a conta nascem agora.
 * Um PartnerRepresentative 'pending' (sem user_id) passa a 'active' no primeiro
 * acesso da pessoa. Idempotente; nunca troca o titular de um vínculo que já
 * pertence a outra conta.
 */
export async function linkPendingPartnerReps(
  client: any,
  { personId, userId }: any,
): Promise<{ linked: number }> {
  const svc = svcOf(client);
  if (!personId || !userId) return { linked: 0 };

  const rows = await svc.entities.PartnerRepresentative.filter({
    person_id: personId,
    is_deleted: false,
  });

  let linked = 0;
  for (const rep of rows || []) {
    if (!rep?.id) continue;
    if (rep.user_id && rep.user_id !== userId) continue;
    if (rep.user_id === userId && rep.access_status === "active" && rep.is_active !== false) continue;
    await svc.entities.PartnerRepresentative.update(rep.id, {
      user_id: userId,
      is_active: true,
      access_status: "active",
      invite_error: "",
    });
    linked += 1;
  }
  return { linked };
}
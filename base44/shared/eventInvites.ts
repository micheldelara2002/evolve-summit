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

  let invited = false;
  let inviteError = "";
  try {
    await svc.users.inviteUser(emailNorm, "user");
    invited = true;
  } catch (error: any) {
    inviteError = String(error?.message || "Não foi possível enviar o e-mail de convite.");
  }
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

    await ensureMembership(svc, {
      eventId: invite.event_id,
      userId,
      personId,
      personName,
      userEmail: email,
      role: invite.target_role || "manager",
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
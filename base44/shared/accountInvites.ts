// 2026-11-04 — CONTA DO APP ↔ PESSOA (única porta).
//
// Regra de negócio: ninguém participa de um evento (equipe, representante de
// parceiro ou participante) sem CONTA (User) e cadastro (Person). O servidor
// resolve a conta pelo e-mail, e quando ela não existe dispara o convite de
// cadastro; o vínculo pendente é concluído no primeiro acesso
// (getOrCreatePerson → linkPendingInvites / linkPendingPartnerReps).
//
// Nada aqui aceita papel ou identidade vindos do cliente: o e-mail é sempre
// normalizado e a conta é relida da base.

import { normalizeEmail, emailMatchVariants } from "./identity.ts";

export function svcOf(client: any): any {
  return client && client.asServiceRole ? client.asServiceRole : client;
}

/**
 * Conta ativa por e-mail. A base é a fonte da verdade (o objeto da sessão pode
 * estar em cache). Conta excluída NÃO pode receber vínculo novo.
 */
export async function findAccountByEmail(client: any, email: string): Promise<any | null> {
  const svc = svcOf(client);
  const emailNorm = normalizeEmail(email);
  if (!emailNorm) return null;
  const users = await svc.entities.User.filter({ email: { $in: emailMatchVariants(email) } });
  const match = (users || []).find((u: any) => normalizeEmail(u.email) === emailNorm);
  if (!match?.id) return null;
  if (match.account_status === "deleted") return null;
  return match;
}

/** Map normalizado e-mail → conta (uma consulta por lote de e-mails). */
export async function findAccountsByEmails(client: any, emails: string[]): Promise<Map<string, any>> {
  const svc = svcOf(client);
  const wanted = [...new Set((emails || []).map((e: string) => normalizeEmail(e)).filter(Boolean))];
  const map = new Map<string, any>();
  for (let i = 0; i < wanted.length; i += 200) {
    const chunk = wanted.slice(i, i + 200);
    const users = await svc.entities.User.filter({ email: { $in: chunk } });
    for (const u of users || []) {
      const key = normalizeEmail(u?.email);
      if (!key || !u?.id) continue;
      if (u.account_status === "deleted") continue;
      map.set(key, u);
    }
  }
  return map;
}

/**
 * Person única do e-mail; cria quando não existe. Mais de uma Person ativa com
 * o mesmo e-mail é AMBIGUIDADE e é recusada (nunca "pega a primeira").
 */
export async function ensurePersonByEmail(
  client: any,
  { email, fullName }: { email: string; fullName?: string },
): Promise<any> {
  const svc = svcOf(client);
  const emailNorm = normalizeEmail(email);
  if (!emailNorm) throw new Error("missing_email");

  const candidates = await svc.entities.Person.filter({
    contact_email: { $in: emailMatchVariants(email) },
    is_active: { $ne: false },
  });
  const matches = (candidates || []).filter(
    (p: any) => p?.id && normalizeEmail(p.contact_email) === emailNorm,
  );
  if (matches.length > 1) throw new Error("identity_ambiguous");
  if (matches[0]) return matches[0];

  const created = await svc.entities.Person.create({
    full_name: (fullName || "").trim() || emailNorm,
    contact_email: emailNorm,
    is_active: true,
    created_day: new Date().toISOString().slice(0, 10),
  });
  if (!created?.id) throw new Error("person_not_created");
  return created;
}

/** Convite de acesso ao app (sem escopo de evento). */
export async function inviteAccount(
  client: any,
  email: string,
): Promise<{ invited: boolean; error: string }> {
  const svc = svcOf(client);
  const emailNorm = normalizeEmail(email);
  if (!emailNorm) return { invited: false, error: "E-mail ausente." };
  try {
    await svc.users.inviteUser(emailNorm, "user");
    return { invited: true, error: "" };
  } catch (error: any) {
    return { invited: false, error: String(error?.message || "Não foi possível enviar o e-mail de convite.") };
  }
}

/**
 * Convite com escopo de evento, idempotente por (evento, e-mail, papel):
 * reenviar não duplica o registro pendente, só reenvia o e-mail.
 */
export async function inviteToEvent(
  client: any,
  { eventId, email, displayName, role = "attendee", actor }: any,
): Promise<{ status: "sent" | "failed"; invite_id: string; error: string }> {
  const svc = svcOf(client);
  const emailNorm = normalizeEmail(email);
  if (!eventId || !emailNorm) throw new Error("missing_params");

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
      invited_name: String(displayName || "").slice(0, 120),
      target_role: role,
      status: "pending",
      invited_by_user_id: actor?.id || "",
      invited_by_name: actor?.full_name || "",
      is_deleted: false,
    });
  }

  const { invited, error } = await inviteAccount(svc, emailNorm);
  await svc.entities.EventInvite.update(invite.id, {
    invite_sent_at: new Date().toISOString(),
    invite_error: invited ? "" : error,
  });
  return { status: invited ? "sent" : "failed", invite_id: invite.id, error };
}

/**
 * Convites que NÃO puderam ser enviados ficam registrados com o motivo para
 * nova tentativa manual (o importador mostra a lista).
 */
export async function recordFailedInvite(
  client: any,
  { eventId, email, displayName, role = "attendee", actor, error }: any,
): Promise<void> {
  const svc = svcOf(client);
  const emailNorm = normalizeEmail(email);
  if (!eventId || !emailNorm) return;
  const pending = await svc.entities.EventInvite.filter({
    event_id: eventId,
    email: emailNorm,
    target_role: role,
    status: "pending",
    is_deleted: false,
  });
  const payload = {
    event_id: eventId,
    email: emailNorm,
    invited_name: String(displayName || "").slice(0, 120),
    target_role: role,
    status: "pending",
    invited_by_user_id: actor?.id || "",
    invited_by_name: actor?.full_name || "",
    invite_sent_at: new Date().toISOString(),
    invite_error: String(error || "Falha no envio do convite.").slice(0, 300),
    is_deleted: false,
  };
  if (pending?.[0]?.id) {
    await svc.entities.EventInvite.update(pending[0].id, {
      invite_sent_at: payload.invite_sent_at,
      invite_error: payload.invite_error,
    });
    return;
  }
  await svc.entities.EventInvite.create(payload);
}
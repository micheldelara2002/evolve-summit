// P1-A (2026-11-04) — IDENTIDADE CANÔNICA User → Person → Participant.
//
// ESTE ARQUIVO É A ÚNICA PORTA DE ENTRADA de resolução de identidade do app.
// Nenhum fluxo deve consultar `Person.contact_email` por conta própria.
//
// PRECEDÊNCIA (definida aqui e em nenhum outro lugar):
//   1. Vínculo explícito: `user.person_id` → Person existente. É a declaração
//      do próprio sistema de quem é o usuário; vence qualquer e-mail.
//   2. E-mail normalizado: Person cujo `contact_email` normalizado é igual ao
//      e-mail de login normalizado. Pode haver MAIS DE UMA.
//   3. Nenhuma Person — usuário ainda não tem cadastro global.
//
// REGRAS DERIVADAS:
//   • `personIds`  = conjunto VERIFICADO de Persons do usuário (vínculo + todas
//     as correspondências por e-mail). Serve para responder POSSE ("este
//     registro é meu?"). Se duas Persons casam por e-mail, ambas são dele —
//     reconhecer as duas não é "escolher a primeira", é exatidão.
//   • `selfPersonId` = QUEM SOU EU numa escrita. Existe apenas quando é único:
//     o vínculo explícito, ou o único candidato por e-mail.
//   • `ambiguous` = sem vínculo explícito E mais de uma correspondência por
//     e-mail. Operações que precisam de `selfPersonId` são NEGADAS com motivo
//     claro (nunca "pega a primeira"). Operações de posse continuam exatas.
//   • Comparação de e-mail é sempre `normalizeEmail()`; gravação normaliza.
//
// Import (de um entry.ts):
//   import { resolveIdentity, requireSelfPersonId, findMyParticipant } from "../../shared/identity.ts";

export type Identity = {
  userId: string;
  emailRaw: string;
  emailNorm: string;
  emailVariants: string[];
  linkedPersonId: string | null;
  personIds: string[];
  selfPersonId: string | null;
  ambiguous: boolean;
  reason: "ok" | "no_user" | "no_person" | "ambiguous";
};

export type SelfPersonDenial = { ok: false; status: number; error: string; reason: string };
export type SelfPersonOk = { ok: true; personId: string; identity: Identity };

/**
 * Aceita tanto o cliente da request (base44) quanto o service role (svc):
 * Person/Participant são lidas sempre em service role (RLS é admin-only).
 */
function svcOf(client: any): any {
  return client && client.asServiceRole ? client.asServiceRole : client;
}

/** Chave canônica de e-mail: sem espaços nas bordas, minúsculas. */
export function normalizeEmail(value: any): string {
  return String(value == null ? "" : value).trim().toLowerCase();
}

/** Formas de e-mail a consultar (normalizada + bruta distinta) para registros legados. */
export function emailMatchVariants(email: any): string[] {
  const norm = normalizeEmail(email);
  const raw = String(email == null ? "" : email).trim();
  const out = [norm];
  if (raw && raw !== norm) out.push(raw);
  return out.filter(Boolean);
}

/**
 * Resolve a identidade canônica do usuário autenticado.
 * Nunca lança por ausência de identidade — devolve `reason` e conjunto vazio.
 */
export async function resolveIdentity(base44: any, user: any): Promise<Identity> {
  const emailNorm = normalizeEmail(user?.email);
  const base: Identity = {
    userId: user?.id || "",
    emailRaw: String(user?.email || "").trim(),
    emailNorm,
    emailVariants: emailMatchVariants(user?.email),
    linkedPersonId: null,
    personIds: [],
    selfPersonId: null,
    ambiguous: false,
    reason: "no_user",
  };
  if (!user?.id) return base;

  const svc = svcOf(base44);

  // 1. Vínculo explícito — existência basta (Participant/PartnerRepresentative
  //    continuam apontando para a Person mesmo se ela foi desativada).
  if (user.person_id) {
    try {
      const linked = await svc.entities.Person.filter({ id: user.person_id });
      if (linked?.[0]?.id) base.linkedPersonId = linked[0].id;
    } catch { /* trilha de e-mail abaixo ainda pode resolver */ }
  }

  // 2. E-mail normalizado — todas as correspondências ativas.
  const byEmail: string[] = [];
  if (emailNorm) {
    try {
      const rows = await svc.entities.Person.filter({
        contact_email: { $in: base.emailVariants },
        is_active: { $ne: false },
      });
      for (const p of rows || []) {
        if (normalizeEmail(p.contact_email) === emailNorm && p.id) byEmail.push(p.id);
      }
    } catch { /* sem correspondência */ }
  }

  base.personIds = [...new Set([base.linkedPersonId, ...byEmail].filter(Boolean) as string[])];

  // 3. Quem sou eu: vínculo explícito vence; senão, apenas se único.
  if (base.linkedPersonId) {
    base.selfPersonId = base.linkedPersonId;
    base.ambiguous = false; // o vínculo explícito desfaz a ambiguidade
  } else if (base.personIds.length === 1) {
    base.selfPersonId = base.personIds[0];
    base.ambiguous = false;
  } else if (base.personIds.length > 1) {
    base.selfPersonId = null;
    base.ambiguous = true;
  }

  base.reason = base.ambiguous
    ? "ambiguous"
    : base.personIds.length === 0
      ? "no_person"
      : "ok";
  return base;
}

/**
 * Exige uma identidade ÚNICA para agir em nome do usuário (criar pedido de
 * conexão, aceitar, enviar mensagem, salvar meu perfil...).
 * Ambiguidade é NEGAÇÃO com motivo — nunca escolha silenciosa.
 */
export async function requireSelfPersonId(base44: any, user: any): Promise<SelfPersonOk | SelfPersonDenial> {
  const identity = await resolveIdentity(base44, user);
  if (identity.selfPersonId) return { ok: true, personId: identity.selfPersonId, identity };
  if (identity.ambiguous) {
    return {
      ok: false,
      status: 409,
      reason: "identity_ambiguous",
      error:
        "Há mais de um cadastro de pessoa com o seu e-mail. Para continuar, a organização precisa consolidar seu cadastro (um único vínculo de pessoa por usuário).",
    };
  }
  return {
    ok: false,
    status: 403,
    reason: "no_person",
    error: "Seu cadastro de pessoa ainda não existe. Abra seu perfil e salve os dados para continuar.",
  };
}

/** POSSE de Person: o registro está no conjunto verificado do usuário. */
export function identityOwnsPerson(identity: Identity, personId: string): boolean {
  return !!personId && identity.personIds.includes(personId);
}

/** POSSE de Participant: por person_id verificado OU e-mail normalizado. */
export function identityOwnsParticipant(identity: Identity, participant: any): boolean {
  if (!participant) return false;
  if (participant.person_id && identityOwnsPerson(identity, participant.person_id)) return true;
  const email = normalizeEmail(participant.email);
  return !!email && email === identity.emailNorm;
}

/**
 * Participants do usuário em um evento — por person_id OU e-mail normalizado,
 * com consultas direcionadas (nunca varrendo a lista do evento).
 */
export async function findMyParticipants(
  base44: any,
  identity: Identity,
  eventId: string,
  extraFilter: Record<string, any> = {},
): Promise<any[]> {
  if (!eventId) return [];
  const svc = svcOf(base44);
  const filters: Record<string, any>[] = [];
  if (identity.personIds.length > 0) {
    filters.push({
      event_id: eventId,
      person_id: { $in: identity.personIds },
      is_deleted: false,
      ...extraFilter,
    });
  }
  if (identity.emailNorm) {
    filters.push({
      event_id: eventId,
      email: { $in: identity.emailVariants },
      is_deleted: false,
      ...extraFilter,
    });
  }
  if (filters.length === 0) return [];

  const batches = await Promise.all(filters.map((f) => svc.entities.Participant.filter(f)));
  const byId = new Map<string, any>();
  for (const batch of batches) for (const p of batch || []) if (p?.id) byId.set(p.id, p);

  // Reconferência em memória: consultas por e-mail são exatas, mas registros
  // legados podem ter caixa diferente — a comparação canônica decide.
  return [...byId.values()].filter(
    (p) => !p.is_deleted && (p.registration_status || "") !== "cancelled" && identityOwnsParticipant(identity, p),
  );
}

/**
 * O Participant do usuário em um evento, apenas quando ÚNICO.
 * `ambiguous = true` quando há mais de um (nunca devolve "o primeiro").
 */
export async function findMyParticipant(
  base44: any,
  identity: Identity,
  eventId: string,
  extraFilter: Record<string, any> = {},
): Promise<{ participant: any | null; participants: any[]; ambiguous: boolean }> {
  const participants = await findMyParticipants(base44, identity, eventId, extraFilter);
  return {
    participant: participants.length === 1 ? participants[0] : null,
    participants,
    ambiguous: participants.length > 1,
  };
}

/** Resolve somente o person_id canônico (compatibilidade com chamadores antigos). */
export async function resolveUserPersonId(base44: any, user: any): Promise<string | null> {
  const identity = await resolveIdentity(base44, user);
  return identity.selfPersonId || null;
}
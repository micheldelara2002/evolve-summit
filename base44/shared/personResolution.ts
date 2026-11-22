// P2-03 (2026-11-22) — RESOLUÇÃO E REATIVAÇÃO DE PERSON (fonte única).
//
// DEFEITO CORRIGIDO: `commerceFulfillment.ensurePerson` consultava
// `{ is_active: { $ne: false } }` — ou seja, registros INATIVOS nunca apareciam
// no resultado — e logo abaixo tinha um ramo `if (matches[0].is_active === false)
// { reativar }` que era CÓDIGO MORTO: a consulta já os havia excluído. Consequência
// real: uma pessoa com cadastro desativado (inscrição anterior cancelada,
// reembolso, consolidação) recebia uma SEGUNDA Person ao comprar de novo. O
// histórico se partia — pontos, certificados, participações e vínculos ficavam
// divididos entre duas identidades da mesma pessoa.
//
// MODELO DE ESTADOS (explícito, nunca inferido de um único campo):
//   • ACTIVE      — `is_active !== false` e não anonimizada: identidade viva.
//   • INACTIVE    — `is_active === false` e não anonimizada: desativada por
//                   operação (cancelamento, reembolso, consolidação). PODE ser
//                   reativada — de forma explícita, por CAS e auditada.
//   • ANONYMIZED  — `is_anonymized === true` (exclusão LGPD). NUNCA é reativada
//                   nem reutilizada: o registro permanece como está para preservar
//                   o histórico anonimizado. Quem voltar com o mesmo e-mail ganha
//                   uma identidade NOVA (a anterior é irrecuperável por desenho).
//
// GARANTIAS:
//   1. Leitura INCLUI inativos (o filtro de e-mail não esconde mais o registro).
//   2. Falha de leitura = operação RECUSADA (`lookup_unavailable`): criar sem
//      saber o que existe é exatamente o que gera duplicata.
//   3. Reativação é CAS (`is_active: false` + `is_anonymized: {$ne: true}` →
//      `is_active: true`) e gera trilha.
//   4. Concorrência na criação: depois do create, relê e elege o sobrevivente
//      determinístico (created_date + id); quem perdeu se desativa — converge
//      para UMA identidade ativa, sem depender de índice único (a plataforma não
//      oferece).
//   5. Idempotente: repetir a resolução devolve a mesma Person.

import { normalizeEmail, emailMatchVariants } from "./identity.ts";
import { deterministicCompare } from "./deterministicSurvivor.ts";

export type PersonBucket = "active" | "inactive" | "anonymized";

export function isAnonymizedPerson(person: any): boolean {
  return !!person && person.is_anonymized === true;
}

/** Classifica uma Person no modelo de estados (fonte única). */
export function classifyPerson(person: any): PersonBucket {
  if (isAnonymizedPerson(person)) return "anonymized";
  return person?.is_active === false ? "inactive" : "active";
}

export type PersonLookup =
  | { ok: true; active: any[]; inactive: any[]; anonymized: any[] }
  | { ok: false; reason: string; error: string };

/**
 * Busca TODAS as Persons do e-mail, incluindo inativas. Nunca lança.
 */
export async function lookupPersonsByEmail(svc: any, email: any): Promise<PersonLookup> {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: true, active: [], inactive: [], anonymized: [] };

  let rows: any[];
  try {
    rows = await svc.entities.Person.filter({ contact_email: { $in: emailMatchVariants(email) } });
  } catch (err: any) {
    console.error("[personResolution] consulta de Person falhou:", err?.message || err);
    return { ok: false, reason: "lookup_unavailable", error: "Não foi possível consultar os cadastros agora." };
  }
  if (!Array.isArray(rows)) {
    return { ok: false, reason: "lookup_unavailable", error: "Consulta de cadastros retornou resposta inválida." };
  }

  const active: any[] = [];
  const inactive: any[] = [];
  const anonymized: any[] = [];
  for (const person of rows) {
    if (!person?.id) continue;
    if (normalizeEmail(person.contact_email) !== normalized) continue;
    const bucket = classifyPerson(person);
    if (bucket === "anonymized") anonymized.push(person);
    else if (bucket === "inactive") inactive.push(person);
    else active.push(person);
  }
  active.sort(deterministicCompare);
  inactive.sort(deterministicCompare);
  anonymized.sort(deterministicCompare);
  return { ok: true, active, inactive, anonymized };
}

export type PersonResolution =
  | {
      ok: true;
      personId: string;
      person: any;
      created: boolean;
      reactivated: boolean;
      audited: boolean;
    }
  | { ok: false; reason: string; error: string };

// Trilha da decisão de identidade. Best-effort: a reativação em si é CAS e
// idempotente, então uma falha de trilha não pode desfazer a identidade (nem
// criar uma duplicata). O resultado é devolvido em `audited`.
async function auditPersonDecision(
  svc: any,
  entry: {
    type: string;
    personId: string;
    actorId?: string;
    actorName?: string;
    eventId?: string;
    reason?: string;
  },
): Promise<boolean> {
  try {
    await svc.entities.AuditLog.create({
      action: "update",
      entity_type: "Person",
      entity_id: entry.personId,
      user_id: entry.actorId || "system",
      user_name: entry.actorName || "Sistema",
      event_id: entry.eventId || "",
      details: JSON.stringify({
        type: entry.type,
        person_id: entry.personId,
        motivo: entry.reason || "",
      }),
    });
    return true;
  } catch (err: any) {
    console.error("[personResolution] trilha de identidade indisponível:", err?.message || err);
    return false;
  }
}

/**
 * Resolve a Person do e-mail — reutiliza ativa, REATIVA inativa (CAS + trilha),
 * nunca reativa anonimizada e só cria quando não há identidade reutilizável.
 * Nunca lança; falha de leitura é recusa (fail-closed).
 */
export async function resolveOrCreatePerson(
  svc: any,
  opts: {
    name: string;
    email: string;
    phone?: string;
    actor?: { id?: string; name?: string };
    eventId?: string;
    reason?: string;
    extra?: Record<string, any>;
  },
): Promise<PersonResolution> {
  const normalized = normalizeEmail(opts?.email);
  if (!normalized) {
    return { ok: false, reason: "email_invalido", error: "E-mail inválido para identificar a pessoa." };
  }

  const lookup = await lookupPersonsByEmail(svc, normalized);
  if (!lookup.ok) return lookup;

  if (lookup.active.length > 0) {
    const person = lookup.active[0];
    return { ok: true, personId: person.id, person, created: false, reactivated: false, audited: false };
  }

  if (lookup.inactive.length > 0) {
    const candidate = lookup.inactive[0];
    let revived: any = null;
    try {
      revived = await svc.entities.Person.updateMany(
        { id: candidate.id, is_active: false, is_anonymized: { $ne: true } },
        { $set: { is_active: true } },
      );
    } catch (err: any) {
      console.error("[personResolution] reativação falhou:", candidate.id, err?.message || err);
      return { ok: false, reason: "reactivation_failed", error: "Não foi possível reativar o cadastro agora." };
    }

    if (revived && revived.updated) {
      const audited = await auditPersonDecision(svc, {
        type: "person_reactivated",
        personId: candidate.id,
        actorId: opts.actor?.id,
        actorName: opts.actor?.name,
        eventId: opts.eventId,
        reason: opts.reason || "identidade_reutilizada",
      });
      return {
        ok: true,
        personId: candidate.id,
        person: { ...candidate, is_active: true },
        created: false,
        reactivated: true,
        audited,
      };
    }

    // CAS perdido (outra requisição reativou/alterou): relê e decide pelo estado.
    const again = await lookupPersonsByEmail(svc, normalized);
    if (!again.ok) return again;
    if (again.active.length > 0) {
      const person = again.active[0];
      return { ok: true, personId: person.id, person, created: false, reactivated: false, audited: false };
    }
    if (again.inactive.length > 0) {
      return {
        ok: false,
        reason: "reactivation_conflict",
        error: "Não foi possível reativar o cadastro agora. Tente novamente em instantes.",
      };
    }
    // Restou apenas anonimizada: segue para criação de identidade nova.
  }

  let created: any = null;
  try {
    created = await svc.entities.Person.create({
      full_name: opts?.name || "Novo Usuário",
      contact_email: normalized,
      phone: opts?.phone || "",
      is_active: true,
      is_anonymized: false,
      created_day: new Date().toISOString().slice(0, 10),
      metrics_inc: true,
      ...(opts?.extra || {}),
    });
  } catch (err: any) {
    console.error("[personResolution] criação de Person falhou:", err?.message || err);
    return { ok: false, reason: "create_failed", error: "Não foi possível criar o cadastro da pessoa." };
  }
  if (!created?.id) {
    return { ok: false, reason: "create_unconfirmed", error: "O cadastro da pessoa não confirmou a gravação." };
  }

  // Convergência de corrida: relê e mantém apenas o sobrevivente determinístico.
  const after = await lookupPersonsByEmail(svc, normalized);
  if (after.ok && after.active.length > 1) {
    const survivor = after.active[0];
    if (survivor.id !== created.id) {
      try {
        await svc.entities.Person.update(created.id, { is_active: false });
      } catch (err: any) {
        console.error("[personResolution] desativação do duplicado falhou:", err?.message || err);
      }
      await auditPersonDecision(svc, {
        type: "person_duplicate_converged",
        personId: survivor.id,
        actorId: opts.actor?.id,
        actorName: opts.actor?.name,
        eventId: opts.eventId,
        reason: "corrida_de_criacao",
      });
      return { ok: true, personId: survivor.id, person: survivor, created: false, reactivated: false, audited: true };
    }
  }

  return { ok: true, personId: created.id, person: created, created: true, reactivated: false, audited: false };
}
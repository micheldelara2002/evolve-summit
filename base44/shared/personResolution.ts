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
import { buildAuditKey, recordPendingTrailVerified, writeMandatoryAudit } from "./auditTrail.ts";

// P2-03 (residual) — EVIDÊNCIA DURÁVEL DA REATIVAÇÃO.
//
// DEFEITO CORRIGIDO: a reativação era CAS + trilha best-effort. Se a gravação do
// AuditLog falhasse, a mutação permanecia aplicada e `audited: false` era
// devolvido — uma alteração de estado sem trilha confiável e sem nenhum caminho
// que voltasse para gravá-la.
//
// AGORA a ordem é: INTENÇÃO durável → mutação → CONCLUSÃO. A intenção é um caso
// de trilha pendente (AuditLog status 'pending' com a entrada original dentro),
// gravado e CONFIRMADO por leitura ANTES do CAS. Consequências:
//   • sem intenção confirmada, a reativação NÃO acontece (fail-closed): nenhuma
//     mutação de identidade existe sem evidência durável correlacionável;
//   • crash depois do CAS e antes da trilha: a intenção continua durável e a
//     rotina de manutenção (resolvePendingTrails) grava a trilha original —
//     a operação é recuperável, não silenciosa;
//   • CAS perdido (outra execução reativou): a intenção é encerrada como NÃO
//     aplicada, para nunca virar uma trilha que atribui a este ator uma
//     reativação que ele não executou.
//
// LIMITAÇÃO DECLARADA: a plataforma não tem transação entre documentos, então
// NÃO existe atomicidade entre o AuditLog e a Person. O que existe é ordem
// obrigatória + evidência durável + recuperação automática.
function newOperationId(): string {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function closeAuditIntent(svc: any, pendingId: string, reason: string): Promise<void> {
  if (!pendingId) return;
  try {
    await svc.entities.AuditLog.update(pendingId, {
      status: "resolved",
      resolved_at: new Date().toISOString(),
      failure_reason: reason,
    });
  } catch (err: any) {
    // Se nem o encerramento gravar, o caso pendente continua visível para a
    // rotina de manutenção — nunca desaparece em silêncio.
    console.error("[personResolution] encerramento da intenção de trilha falhou:", err?.message || err);
  }
}

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
      /** P2-03 — quando a trilha não pôde ser confirmada na hora: id do caso
       *  pendente DURÁVEL que a reconciliação vai concluir. */
      pendingTrailId?: string;
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

    // (1) INTENÇÃO DURÁVEL — antes de qualquer mutação. A chave é determinística
    // por ocorrência (gerada no servidor): retry e reconciliação convergem para
    // UM único registro de trilha, nunca dois.
    const occurrence = newOperationId();
    const auditKey = buildAuditKey("person_reactivated", candidate.id, occurrence);
    const trailEntry = {
      action: "update",
      entity_type: "Person",
      entity_id: candidate.id,
      user_id: opts.actor?.id || "system",
      user_name: opts.actor?.name || "Sistema",
      event_id: opts.eventId || "",
      audit_key: auditKey,
      details: JSON.stringify({
        type: "person_reactivated",
        person_id: candidate.id,
        occurrence,
        motivo: opts.reason || "identidade_reutilizada",
        de: "inactive",
        para: "active",
      }),
    };
    const intent = await recordPendingTrailVerified(svc, {
      ...trailEntry,
      failure_reason: "Reativação de cadastro em andamento — trilha a confirmar.",
    });
    if (!intent) {
      // Sem evidência durável NÃO há reativação (fail-closed).
      return {
        ok: false,
        reason: "audit_intent_unavailable",
        error: "Não foi possível registrar a evidência desta reativação. Nada foi alterado — tente novamente em instantes.",
      };
    }

    // (2) MUTAÇÃO idempotente: só inativa e não anonimizada (LGPD preservada).
    let revived: any = null;
    try {
      revived = await svc.entities.Person.updateMany(
        { id: candidate.id, is_active: false, is_anonymized: { $ne: true } },
        { $set: { is_active: true } },
      );
    } catch (err: any) {
      console.error("[personResolution] reativação falhou:", candidate.id, err?.message || err);
      await closeAuditIntent(svc, intent.id, "Reativação não aplicada: falha de escrita.");
      return { ok: false, reason: "reactivation_failed", error: "Não foi possível reativar o cadastro agora." };
    }

    if (revived && revived.updated) {
      // (3) CONCLUSÃO: trilha obrigatória confirmada. Se falhar agora, a
      // intenção permanece pendente e a rotina de manutenção a grava — a
      // operação é recuperável e o caso NÃO fica sem evidência.
      let audited = false;
      try {
        await writeMandatoryAudit(svc, trailEntry);
        audited = true;
        await closeAuditIntent(svc, intent.id, "Trilha da reativação gravada e confirmada.");
      } catch (err: any) {
        console.error("[personResolution] trilha da reativação pendente:", err?.message || err);
      }
      return {
        ok: true,
        personId: candidate.id,
        person: { ...candidate, is_active: true },
        created: false,
        reactivated: true,
        audited,
        pendingTrailId: audited ? "" : intent.id,
      };
    }

    // CAS perdido: encerra a intenção como NÃO aplicada — nunca deixá-la virar
    // uma trilha que atribui a este ator uma reativação feita por outra execução.
    await closeAuditIntent(svc, intent.id, "Reativação não aplicada (corrida) — outra execução alterou o cadastro.");

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
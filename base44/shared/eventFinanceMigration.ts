// Fase 2 (2026-11-12) — migração dos campos financeiros internos do Event.
//
// MOTIVO: `commission_percent`, `payout_account_id`, `refund_policy` e
// `coupon_codes_registry` viviam no Event, cuja RLS de leitura alcança qualquer
// usuário autenticado em eventos `active`/`finished`. A migração copia os valores
// para `EventFinance` (RLS admin-only) e ESVAZIA o legado no Event — só assim a
// exposição fecha. Enquanto ela não roda, `withEventFinance` lê das duas fontes.
//
// ===== ORDEM DAS OPERAÇÕES (e por que ela é esta) =====
//
//   1. ler o documento financeiro existente;
//   2. criar o documento (se não existe) OU completar só os campos vazios
//      (valor já configurado em EventFinance é a fonte da verdade — nunca é
//      sobrescrito pelo legado);
//   3. CONFIRMAR por leitura que os valores estão gravados;
//   4. gravar a TRILHA OBRIGATÓRIA (lança se não confirmar);
//   5. só então limpar os campos legados no Event;
//   6. CONFIRMAR por leitura que o legado foi esvaziado.
//
// A trilha vem ANTES da limpeza por um motivo específico: se ela viesse depois,
// uma falha na limpeza deixaria o evento sem legado e sem trilha — e a reexecução
// encontraria "nada a migrar" e nunca gravaria a trilha, perdendo o registro de
// uma alteração feita. Nesta ordem, toda limpeza tem trilha prévia, e a trilha é
// idempotente por `event_finance_migrado|<eventId>` (reexecução não duplica).
//
// ===== FALHA PARCIAL (a plataforma NÃO tem transação entre documentos) =====
//
// | falhou em            | estado após a falha                        | reexecução                  |
// |----------------------|--------------------------------------------|-----------------------------|
// | criar/atualizar doc  | EventFinance sem os valores; legado INTACTO | cria/completa e limpa       |
// | confirmar doc        | idem (nada foi limpo)                       | idem                        |
// | gravar trilha        | doc financeiro completo; legado INTACTO     | trilha + limpeza            |
// | limpar legado        | doc + trilha OK; legado ainda exposto       | limpa (trilha é duplicada)  |
// | confirmar limpeza    | idem                                        | limpa/reconfirma            |
//
// Em nenhum cenário o legado é apagado sem que o dado já esteja gravado em
// EventFinance E a trilha gravada. Nenhum documento é apagado em nenhum cenário
// (exclusão lógica de evento é preservada, não convertida em exclusão física).
//
// ===== PAGINAÇÃO =====
//
// Cursor do SDK (`filter(query, { sort, limit, cursor })` → `{ items, next_cursor,
// has_more }`). O filtro NÃO é "eventos que precisam migrar": ele é fixo (todos os
// eventos), porque a migração altera os próprios documentos que seriam filtrados e
// um conjunto que encolhe no meio da paginação faz o cursor pular registros. Como
// created_date nunca é alterado, a ordem permanece estável entre as páginas.
//
// Se algum evento da página falhar, a execução NÃO avança o cursor: devolve o
// cursor de ENTRADA (o mesmo da página) com `retry_page: true`, para que a próxima
// execução releia exatamente esta página. Eventos já migrados voltam como
// `already_clean` (no-op) e os que falharam são retentados — nada é pulado.

import { EVENT_FINANCE_FIELDS } from "./eventFinance.ts";
import { buildAuditKey, writeMandatoryAudit } from "./auditTrail.ts";

export const MIGRATION_AUDIT_OPERATION = "event_finance_migrado";

const LEGACY_CLEAR_PATCH = {
  commission_percent: null,
  payout_account_id: "",
  refund_policy: "",
  coupon_codes_registry: [],
};

function hasValue(v: any): boolean {
  return v !== undefined && v !== null && v !== "";
}

function isEmpty(v: any): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function msg(err: any): string {
  return err?.message || String(err);
}

// Valores legados realmente presentes no Event (o que precisa ser migrado).
function legacyValues(event: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const field of EVENT_FINANCE_FIELDS) {
    const value = event?.[field];
    if (!hasValue(value)) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[field] = value;
  }
  return out;
}

// Confirma, por leitura, que os valores estão no documento financeiro.
async function confirmFinancePersisted(
  svc: any,
  eventId: string,
  expected: Record<string, any>,
): Promise<{ ok: boolean; reason?: string; financeId?: string }> {
  let doc: any = null;
  try {
    const rows = await svc.entities.EventFinance.filter({ event_id: eventId });
    doc = (rows && rows[0]) || null;
  } catch (err: any) {
    return { ok: false, reason: `Leitura de confirmação de EventFinance indisponível: ${msg(err)}` };
  }
  if (!doc) {
    return { ok: false, reason: "EventFinance não encontrado após a escrita — nada foi limpo no evento." };
  }
  const missing = Object.keys(expected).filter((field) => !hasValue(doc[field]));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Campos não persistidos em EventFinance: ${missing.join(", ")} — nada foi limpo no evento.`,
    };
  }
  return { ok: true, financeId: doc.id };
}

// Confirma, por leitura, que o legado foi esvaziado no Event.
async function confirmLegacyCleared(svc: any, eventId: string): Promise<{ ok: boolean; reason?: string }> {
  let event: any = null;
  try {
    const rows = await svc.entities.Event.filter({ id: eventId });
    event = (rows && rows[0]) || null;
  } catch (err: any) {
    return { ok: false, reason: `Leitura de confirmação do evento indisponível: ${msg(err)}` };
  }
  if (!event) {
    return { ok: false, reason: "Evento não encontrado após a limpeza — não é possível confirmar." };
  }
  const remaining = EVENT_FINANCE_FIELDS.filter((field) => !isEmpty(event[field]));
  if (remaining.length > 0) {
    return { ok: false, reason: `Campos legados ainda presentes no evento: ${remaining.join(", ")}` };
  }
  return { ok: true };
}

export interface MigrationOptions {
  dryRun?: boolean;
  cursor?: string | null;
  limit?: number;
  eventId?: string;
  actor?: { id?: string; name?: string };
}

// Migra UM evento. Devolve sempre um resultado (nunca lança): falha é reportada
// com o estágio exato e o legado permanece intacto.
async function migrateOne(svc: any, event: any, dryRun: boolean, actor: any): Promise<any> {
  const legacy = legacyValues(event);
  const fields = Object.keys(legacy);
  const base = {
    event_id: event.id,
    name: event.name || "",
    fields,
    soft_deleted: event.is_deleted === true,
  };

  const fail = (stage: string, error: string) => ({ ...base, status: "failed", action: "failed", stage, error });

  let existing: any = null;
  try {
    const rows = await svc.entities.EventFinance.filter({ event_id: event.id });
    existing = (rows && rows[0]) || null;
  } catch (err: any) {
    return fail("finance_read", `Documento financeiro não pôde ser lido: ${msg(err)}`);
  }

  // Sem legado não há o que migrar nem o que limpar — com ou sem documento
  // financeiro, o evento já está no estado final (a limpeza nunca acontece antes
  // da trilha, então "sem legado" implica "já migrado e já auditado").
  if (fields.length === 0) {
    return { ...base, status: "clean", action: "nothing_to_migrate" };
  }

  // Só completa o que estiver vazio: valor já configurado em EventFinance vence.
  const patch: any = {};
  if (existing) {
    for (const field of fields) {
      if (isEmpty(existing[field])) patch[field] = legacy[field];
    }
  }
  const patchFields = Object.keys(patch);

  if (dryRun) {
    let action = "create";
    if (existing) action = patchFields.length > 0 ? "merge_legacy_into_existing" : "clear_legacy_only";
    return {
      ...base,
      status: existing ? (patchFields.length > 0 ? "merged" : "cleared_only") : "created",
      action,
    };
  }

  // (2) Persistência do documento financeiro.
  let financeId = existing?.id || "";
  let expected: Record<string, any> = {};

  if (!existing) {
    expected = legacy;
    let created: any = null;
    try {
      created = await svc.entities.EventFinance.create({ event_id: event.id, ...legacy });
    } catch (err: any) {
      return fail("finance_create", `EventFinance não foi criado: ${msg(err)} — nada foi limpo no evento.`);
    }
    if (!created || !created.id) {
      return fail("finance_create", "EventFinance não confirmou a criação — nada foi limpo no evento.");
    }
    financeId = created.id;
  } else if (patchFields.length > 0) {
    expected = patch;
    try {
      await svc.entities.EventFinance.update(financeId, patch);
    } catch (err: any) {
      return fail("finance_update", `EventFinance não foi atualizado: ${msg(err)} — nada foi limpo no evento.`);
    }
  }

  // (3) Confirmação da persistência antes de qualquer limpeza.
  if (Object.keys(expected).length > 0) {
    const confirmed = await confirmFinancePersisted(svc, event.id, expected);
    if (!confirmed.ok) {
      return fail("finance_confirm", confirmed.reason || "Persistência do documento financeiro não confirmada.");
    }
    if (confirmed.financeId) financeId = confirmed.financeId;
  }

  // (4) Trilha obrigatória — sem confirmação, o evento NÃO é limpo.
  try {
    await writeMandatoryAudit(svc, {
      action: "update",
      entity_type: "EventFinance",
      entity_id: financeId,
      user_id: actor.id,
      user_name: actor.name,
      event_id: event.id,
      audit_key: buildAuditKey(MIGRATION_AUDIT_OPERATION, event.id),
      provider: "internal",
      amount: 0,
      details: JSON.stringify({
        type: MIGRATION_AUDIT_OPERATION,
        event_id: event.id,
        campos: fields,
        criado: !existing,
        completados: patchFields,
        evento_excluido_logicamente: event.is_deleted === true,
      }),
    });
  } catch (err: any) {
    return fail("audit", `Trilha obrigatória não gravada: ${msg(err)} — campos legados preservados no evento.`);
  }

  // (5) Limpeza do legado — única etapa que fecha a exposição.
  try {
    await svc.entities.Event.update(event.id, LEGACY_CLEAR_PATCH);
  } catch (err: any) {
    return fail(
      "legacy_clear",
      `Campos legados não foram limpos: ${msg(err)} — dado já está em EventFinance e a trilha está gravada; reexecute para concluir.`,
    );
  }

  // (6) Confirmação da limpeza — nada é reportado como migrado sem prova.
  const cleared = await confirmLegacyCleared(svc, event.id);
  if (!cleared.ok) {
    return fail("legacy_confirm", cleared.reason || "Limpeza do legado não confirmada.");
  }

  return {
    ...base,
    status: !existing ? "created" : (patchFields.length > 0 ? "merged" : "cleared_only"),
    action: !existing ? "create" : (patchFields.length > 0 ? "merge" : "clear_legacy_only"),
  };
}

// Executa UM lote da migração.
export async function migrateEventFinanceBatch(svc: any, options: MigrationOptions = {}): Promise<any> {
  const dryRun = options.dryRun !== false;
  const singleEventId = typeof options.eventId === "string" ? options.eventId.trim() : "";
  let limit = Number(options.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  limit = Math.min(Math.floor(limit), 500);
  const incomingCursor = typeof options.cursor === "string" && options.cursor ? options.cursor : null;
  const actor = {
    id: options.actor?.id || "system",
    name: options.actor?.name || "Migração EventFinance",
  };

  let events: any[] = [];
  let pageNextCursor: string | null = null;
  let pageHasMore = false;

  if (singleEventId) {
    // Modo evento único: sem paginação (id é a chave exata).
    const rows = await svc.entities.Event.filter({ id: singleEventId });
    events = Array.isArray(rows) ? rows : (rows?.items || []);
  } else {
    const pageOptions: any = { sort: "created_date", limit };
    if (incomingCursor) pageOptions.cursor = incomingCursor;
    const page = await svc.entities.Event.filter({}, pageOptions);
    events = Array.isArray(page) ? page : (page?.items || []);
    pageNextCursor = (!Array.isArray(page) && page?.next_cursor) || null;
    pageHasMore = Array.isArray(page) ? false : !!page?.has_more;
  }

  const details: any[] = [];
  const counters = { created: 0, merged: 0, cleared_only: 0, already_clean: 0, failed: 0, audit_failures: 0 };

  for (const event of events) {
    const result = await migrateOne(svc, event, dryRun, actor);
    details.push(result);
    if (result.status === "created") counters.created++;
    else if (result.status === "merged") counters.merged++;
    else if (result.status === "cleared_only") counters.cleared_only++;
    else if (result.status === "clean") counters.already_clean++;
    else {
      counters.failed++;
      if (result.stage === "audit") counters.audit_failures++;
      console.error("[migrateEventFinance] falha:", event.id, result.stage, result.error);
    }
  }

  const failures = details
    .filter((d) => d.status === "failed")
    .map((d) => ({ event_id: d.event_id, name: d.name, stage: d.stage, error: d.error }));

  // Falha na página ⇒ o cursor NÃO avança: a próxima execução relê esta página.
  const retryPage = !singleEventId && counters.failed > 0;
  const nextCursor = singleEventId
    ? null
    : (retryPage ? incomingCursor : pageNextCursor);
  const hasMore = singleEventId ? false : (retryPage ? true : pageHasMore);

  return {
    ok: counters.failed === 0,
    dry_run: dryRun,
    mode: singleEventId ? "single" : "batch",
    complete: !singleEventId && counters.failed === 0 && !pageHasMore,
    scanned: events.length,
    limit,
    created: counters.created,
    merged: counters.merged,
    cleared_only: counters.cleared_only,
    already_clean: counters.already_clean,
    failed: counters.failed,
    audit_failures: counters.audit_failures,
    has_more: hasMore,
    next_cursor: nextCursor,
    retry_page: retryPage,
    cursor_used: singleEventId ? null : incomingCursor,
    failures,
    details,
  };
}
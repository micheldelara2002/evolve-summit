// P2-08 (2026-11-22, residual) — CICLO DURÁVEL DA OPERAÇÃO DE REPASSE.
//
// DEFEITO CORRIGIDO: a trilha registrava apenas "solicitada". Não havia prova
// do desfecho: o provedor podia falhar depois da intenção, podia CONCLUIR e a
// gravação local falhar, ou podia dar timeout — resultado desconhecido, que não
// é falha nem sucesso. Em todos esses casos o estado local e o externo podiam
// divergir em silêncio.
//
// DESENHO (sem transação entre documentos e sem presumir o resultado de um
// timeout):
//
//   1. operation_id estável + idempotency_key DETERMINÍSTICA (conta + valor em
//      centavos, nunca o horário).
//   2. PayoutOperation é gravada como `intent_recorded` ANTES de qualquer efeito
//      externo. Se a intenção não grava, o provedor NÃO é chamado.
//   3. Trilha obrigatória da intenção. Sem trilha, o provedor NÃO é chamado (a
//      operação é encerrada como não executada, com o motivo registrado).
//   4. Chamada ao provedor devolve TRÊS desfechos distintos: confirmed, failed
//      (recusa explícita, nada aplicado) ou unknown (sem resposta conclusiva).
//      `unknown` vira `reconciliation_required` — nunca é tratado como falha.
//   5. Só `provider_confirmed` aplica o estado local, e o local só é dado como
//      aplicado depois de CONFIRMADO POR LEITURA.
//   6. Reconciliação reenvia a MESMA requisição com a MESMA idempotency key: o
//      provedor devolve o resultado original em vez de executar de novo, então
//      nenhum efeito externo é duplicado. Operação já confirmada só conclui o
//      lado local, sem tocar o provedor. Conflito de idempotência (mesma chave,
//      parâmetros diferentes) vira `divergent` e exige intervenção humana.
//   7. Trilha de conclusão obrigatória; se falhar, fica como caso PENDENTE
//      durável (resolvePendingTrails conclui) e a operação marca audit_pending.

import { buildAuditKey, recordPendingTrailVerified, writeMandatoryAudit } from "./auditTrail.ts";
import { applyPayoutReserve, type PayoutProviderOutcome } from "./stripeClient.ts";

const ENTITY = "PayoutOperation";

// Janela de tolerância antes de a reconciliação agir sobre uma intenção ainda
// `intent_recorded` (a requisição original pode estar em andamento agora).
export const PAYOUT_OPERATION_GRACE_MS = 2 * 60 * 1000;

const TERMINAL_STATES = ["provider_confirmed", "provider_failed", "divergent"];

export function buildPayoutIdempotencyKey(accountId: string, amountCents: number, operationType = "payout_reserve"): string {
  return `${operationType}:${String(accountId || "")}:${Math.round(Number(amountCents) || 0)}`;
}

function newOperationId(): string {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export type PayoutOperationState =
  | "provider_confirmed"
  | "provider_failed"
  | "reconciliation_required"
  | "divergent"
  | "intent_unavailable";

export type PayoutOperationResult = {
  ok: boolean;
  state: PayoutOperationState;
  operation: any | null;
  error?: string;
  /** Valor local confirmado por leitura, quando aplicado. */
  localApplied: boolean;
  /** Já existia uma operação com a mesma chave (replay idempotente). */
  replayed: boolean;
};

type ProviderFn = (op: any) => Promise<PayoutProviderOutcome>;
type ApplyLocalFn = (op: any) => Promise<{ applied: boolean; error?: string }>;

function defaultProvider(op: any): Promise<PayoutProviderOutcome> {
  return applyPayoutReserve({
    accountId: String(op.stripe_account_id || ""),
    minimumBalanceCents: Math.round(Number(op.amount_cents) || 0),
    debitNegativeBalances: true,
    idempotencyKey: String(op.idempotency_key || ""),
  });
}

async function defaultApplyLocal(svc: any, op: any): Promise<{ applied: boolean; error?: string }> {
  const target = Number(op.amount_brl) || 0;
  try {
    await svc.entities.PayoutAccount.update(String(op.account_id), { reserve_amount: target });
  } catch (err: any) {
    return { applied: false, error: `escrita_local_falhou:${err?.message || err}` };
  }
  let confirmed: any = null;
  try {
    confirmed = (await svc.entities.PayoutAccount.filter({ id: String(op.account_id) }))[0] || null;
  } catch (err: any) {
    return { applied: false, error: `confirmacao_indisponivel:${err?.message || err}` };
  }
  if (!confirmed || Number(confirmed.reserve_amount) !== target) {
    return { applied: false, error: "estado_local_nao_confirmado" };
  }
  return { applied: true };
}

async function findOperation(svc: any, idempotencyKey: string): Promise<any | null> {
  const rows = await svc.entities[ENTITY].filter({ idempotency_key: idempotencyKey, is_deleted: false });
  if (!Array.isArray(rows)) throw new Error("leitura_invalida");
  if (rows.length === 0) return null;
  return [...rows].sort((a: any, b: any) => {
    const da = String(a?.created_date || "");
    const db = String(b?.created_date || "");
    if (da !== db) return da < db ? -1 : 1;
    return String(a?.id || "") < String(b?.id || "") ? -1 : 1;
  })[0];
}

// Transição de estado por CAS: cada passo declara de QUAIS estados pode sair,
// então um estado terminal nunca é sobrescrito por engano. Os dois passos
// posteriores à confirmação (aplicar o local e rebaixar para reconciliação
// quando a confirmação local falha) saem de `provider_confirmed` — sem isso a
// operação ficava presa em `provider_confirmed` com `local_applied: false`.
const FROM_UNSETTLED = ["intent_recorded", "reconciliation_required"];
const FROM_CONFIRMED = ["provider_confirmed"];
const FROM_ANY_OPEN = ["intent_recorded", "reconciliation_required", "provider_confirmed"];

async function transition(
  svc: any,
  id: string,
  patch: Record<string, any>,
  fromStates: string[] = FROM_UNSETTLED,
): Promise<boolean> {
  try {
    const res = await svc.entities[ENTITY].updateMany(
      { id, state: { $in: fromStates } },
      { $set: { ...patch, result_at: new Date().toISOString() } },
    );
    return !!(res && res.updated);
  } catch (err: any) {
    console.error("[payoutOperation] transição de estado falhou:", err?.message || err);
    return false;
  }
}

async function bumpAttempts(svc: any, id: string): Promise<void> {
  try {
    await svc.entities[ENTITY].updateMany({ id }, { $inc: { attempts: 1 } });
  } catch { /* diagnóstico */ }
}

async function writeIntentTrail(svc: any, op: any, extra: Record<string, any> = {}): Promise<void> {
  await writeMandatoryAudit(svc, {
    action: "update",
    entity_type: "PayoutAccount",
    entity_id: String(op.account_id),
    user_id: String(op.actor_user_id || "system"),
    user_name: String(op.actor_name || "Sistema"),
    event_id: String(op.event_id || ""),
    audit_key: buildAuditKey("config_repasse_alterada", `reserva_saldo:${op.operation_id}`),
    provider: "stripe",
    external_reference: String(op.stripe_account_id || ""),
    amount: Number(op.amount_brl) || 0,
    details: JSON.stringify({
      type: "reserva_saldo_alterada",
      operation_id: op.operation_id,
      idempotency_key: op.idempotency_key,
      correlation_id: op.correlation_id,
      event_id: op.event_id,
      conta_payout_id: op.account_id,
      conta_provedor: op.stripe_account_id,
      valor_anterior: op.previous_brl,
      valor_novo: op.amount_brl,
      valor_centavos: op.amount_cents,
      moeda: op.currency || "BRL",
      estado: "intent_recorded",
      motivo: op.reason || "",
      ...extra,
    }),
  });
}

// Trilha de conclusão: obrigatória, com queda para caso pendente durável.
async function writeResultTrail(svc: any, op: any, state: string, extra: Record<string, any> = {}): Promise<boolean> {
  const entry = {
    action: "update",
    entity_type: "PayoutAccount",
    entity_id: String(op.account_id),
    user_id: String(op.actor_user_id || "system"),
    user_name: String(op.actor_name || "Sistema"),
    event_id: String(op.event_id || ""),
    audit_key: buildAuditKey("config_repasse_alterada", `reserva_saldo:${op.operation_id}`, "resultado"),
    provider: "stripe",
    external_reference: String(op.provider_reference || op.stripe_account_id || ""),
    amount: Number(op.amount_brl) || 0,
    details: JSON.stringify({
      type: "reserva_saldo_resultado",
      operation_id: op.operation_id,
      idempotency_key: op.idempotency_key,
      correlation_id: op.correlation_id,
      estado: state,
      referencia_provedor: op.provider_reference || "",
      status_provedor: op.provider_status || "",
      valor_novo: op.amount_brl,
      valor_centavos: op.amount_cents,
      ...extra,
    }),
  };
  try {
    await writeMandatoryAudit(svc, entry);
    return true;
  } catch (err: any) {
    console.error("[payoutOperation] trilha de conclusão indisponível:", err?.message || err);
    const pending = await recordPendingTrailVerified(svc, {
      ...entry,
      failure_reason: "Desfecho da operação de repasse sem trilha confirmada.",
    });
    return !pending;
  }
}

/**
 * Executa (ou RETOMA) a operação de repasse com ciclo rastreável.
 * Nenhum efeito externo acontece sem intenção durável + trilha da intenção.
 */
export async function runPayoutOperation(
  svc: any,
  params: {
    eventId: string;
    account: any;
    actor?: { id?: string; name?: string };
    amountCents: number;
    amountBrl: number;
    previousBrl: number;
    currency?: string;
    reason?: string;
    operationType?: string;
    provider?: ProviderFn;
    applyLocal?: ApplyLocalFn;
    nowMs?: number;
  },
): Promise<PayoutOperationResult> {
  const operationType = String(params?.operationType || "payout_reserve");
  const account = params?.account || {};
  const accountId = String(account.id || "");
  const amountCents = Math.round(Number(params?.amountCents) || 0);
  if (!accountId || !account?.stripe_account_id) {
    return { ok: false, state: "intent_unavailable", operation: null, error: "Conta de repasse inválida.", localApplied: false, replayed: false };
  }
  const provider = params.provider || defaultProvider;
  const applyLocal = params.applyLocal || ((op: any) => defaultApplyLocal(svc, op));
  const idempotencyKey = buildPayoutIdempotencyKey(accountId, amountCents, operationType);

  // (1) REPLAY: a mesma operação (mesma chave) não gera segundo efeito externo.
  let operation: any = null;
  try {
    operation = await findOperation(svc, idempotencyKey);
  } catch (err: any) {
    console.error("[payoutOperation] leitura da operação falhou:", err?.message || err);
    return { ok: false, state: "intent_unavailable", operation: null, error: "Não foi possível verificar a operação de repasse agora.", localApplied: false, replayed: false };
  }

  if (operation) {
    if (operation.state === "provider_failed") {
      return { ok: false, state: "provider_failed", operation, error: operation.provider_error || "O provedor recusou esta operação.", localApplied: false, replayed: true };
    }
    if (operation.state === "divergent") {
      return { ok: false, state: "divergent", operation, error: "Esta operação conflita com uma tentativa anterior com a mesma chave. Requer revisão manual.", localApplied: false, replayed: true };
    }
    if (operation.state === "provider_confirmed") {
      // Efeito externo já existe: só falta (ou já foi feito) o lado local.
      if (operation.local_applied === true) {
        return { ok: true, state: "provider_confirmed", operation, localApplied: true, replayed: true };
      }
      const applied = await applyLocal(operation);
      if (!applied.applied) {
        await transition(svc, operation.id, { state: "reconciliation_required", last_error: applied.error || "estado_local_nao_confirmado" }, FROM_CONFIRMED);
        return { ok: false, state: "reconciliation_required", operation: { ...operation, state: "reconciliation_required" }, error: "O provedor confirmou a operação, mas o registro local não confirmou a gravação. A reconciliação concluirá.", localApplied: false, replayed: true };
      }
      await transition(svc, operation.id, { local_applied: true, last_error: "" }, FROM_CONFIRMED);
      return { ok: true, state: "provider_confirmed", operation: { ...operation, local_applied: true }, localApplied: true, replayed: true };
    }
    // intent_recorded / reconciliation_required: retoma pelo caminho comum.
  }

  // (2) INTENÇÃO DURÁVEL — antes de qualquer efeito externo.
  if (!operation) {
    try {
      operation = await svc.entities[ENTITY].create({
        operation_id: newOperationId(),
        idempotency_key: idempotencyKey,
        operation_type: operationType,
        event_id: String(params.eventId || ""),
        account_id: accountId,
        stripe_account_id: String(account.stripe_account_id),
        actor_user_id: String(params.actor?.id || ""),
        actor_name: String(params.actor?.name || ""),
        amount_cents: amountCents,
        amount_brl: Number(params.amountBrl) || 0,
        previous_brl: Number(params.previousBrl) || 0,
        currency: String(params.currency || "BRL"),
        reason: String(params.reason || ""),
        state: "intent_recorded",
        provider: "stripe",
        provider_reference: "",
        provider_status: "",
        provider_error: "",
        local_applied: false,
        audit_pending: false,
        attempts: 0,
        last_error: "",
        correlation_id: "",
        requested_at: new Date().toISOString(),
        is_deleted: false,
      });
    } catch (err: any) {
      console.error("[payoutOperation] intenção não gravada:", err?.message || err);
      return { ok: false, state: "intent_unavailable", operation: null, error: "Não foi possível registrar a operação de repasse. Nada foi alterado.", localApplied: false, replayed: false };
    }
    if (!operation?.id) {
      return { ok: false, state: "intent_unavailable", operation: null, error: "A operação de repasse não confirmou a gravação. Nada foi alterado.", localApplied: false, replayed: false };
    }
    try {
      await svc.entities[ENTITY].update(operation.id, { correlation_id: operation.operation_id });
      operation.correlation_id = operation.operation_id;
    } catch { /* correlação é diagnóstico */ }
  }

  // (3) TRILHA DA INTENÇÃO — sem ela o provedor não é chamado.
  try {
    await writeIntentTrail(svc, operation);
  } catch (err: any) {
    console.error("[payoutOperation] trilha da intenção indisponível:", err?.message || err);
    await transition(svc, operation.id, {
      state: "provider_failed",
      provider_status: "audit_unavailable",
      provider_error: "Trilha da intenção indisponível — provedor não foi chamado.",
      settled_by: "request",
    });
    // provider_status é devolvido junto: é o que distingue "trilha indisponível"
    // (nada foi executado) de uma recusa do provedor no chamador.
    return {
      ok: false,
      state: "provider_failed",
      operation: { ...operation, state: "provider_failed", provider_status: "audit_unavailable" },
      error: "Não foi possível registrar a trilha desta alteração de repasse. Nada foi alterado — tente novamente em instantes.",
      localApplied: false,
      replayed: false,
    };
  }

  // (4) EFEITO EXTERNO.
  await bumpAttempts(svc, operation.id);
  const outcome = await provider(operation);

  if (outcome.outcome === "failed") {
    const divergent = outcome.errorCode === "idempotency_conflict";
    await transition(svc, operation.id, {
      state: divergent ? "divergent" : "provider_failed",
      provider_status: outcome.errorCode,
      provider_error: outcome.message,
      settled_by: "request",
    });
    const persisted = divergent ? "divergent" : "provider_failed";
    await writeResultTrail(svc, { ...operation, provider_status: outcome.errorCode, provider_error: outcome.message }, persisted);
    return {
      ok: false,
      state: persisted,
      operation: { ...operation, state: persisted, provider_status: outcome.errorCode, provider_error: outcome.message },
      error: divergent
        ? "Esta operação conflita com uma tentativa anterior com a mesma chave. Requer revisão manual."
        : `O provedor recusou a operação: ${outcome.message}`,
      localApplied: false,
      replayed: false,
    };
  }

  if (outcome.outcome === "unknown") {
    // Timeout/indisponibilidade NÃO é falha: o efeito pode ter acontecido.
    await transition(svc, operation.id, {
      state: "reconciliation_required",
      provider_status: outcome.errorCode,
      provider_error: outcome.message,
      settled_by: "request",
    });
    return {
      ok: false,
      state: "reconciliation_required",
      operation: { ...operation, state: "reconciliation_required", provider_status: outcome.errorCode },
      error: "O provedor não respondeu de forma conclusiva. O resultado será reconciliado automaticamente — não repita imediatamente.",
      localApplied: false,
      replayed: false,
    };
  }

  // (5) CONFIRMADO: registra o desfecho e aplica o lado local.
  const confirmedOp = {
    ...operation,
    state: "provider_confirmed",
    provider_reference: outcome.reference,
    provider_status: outcome.status,
  };
  await transition(svc, operation.id, {
    state: "provider_confirmed",
    provider_reference: outcome.reference,
    provider_status: outcome.status,
    provider_error: "",
    settled_by: "request",
  });

  const applied = await applyLocal(confirmedOp);
  if (!applied.applied) {
    await transition(svc, operation.id, { state: "reconciliation_required", last_error: applied.error || "estado_local_nao_confirmado" }, FROM_CONFIRMED);
    await writeResultTrail(svc, confirmedOp, "provider_confirmed_local_pendente", { motivo_local: applied.error || "" });
    return {
      ok: false,
      state: "reconciliation_required",
      operation: { ...confirmedOp, state: "reconciliation_required" },
      error: "O provedor confirmou a operação, mas o registro local não confirmou a gravação. A reconciliação concluirá.",
      localApplied: false,
      replayed: false,
    };
  }
  await transition(svc, operation.id, { local_applied: true, last_error: "" }, FROM_CONFIRMED);
  const audited = await writeResultTrail(svc, confirmedOp, "provider_confirmed", { local_aplicado: true });
  if (!audited) {
    try { await svc.entities[ENTITY].update(operation.id, { audit_pending: true }); } catch { /* caso pendente já é durável */ }
  }
  return { ok: true, state: "provider_confirmed", operation: { ...confirmedOp, local_applied: true }, localApplied: true, replayed: false };
}

/**
 * RECONCILIAÇÃO das operações de repasse sem desfecho.
 *
 * Só age sobre `intent_recorded` (após a janela de tolerância) e
 * `reconciliation_required`. Reenvia a MESMA requisição com a MESMA idempotency
 * key — o provedor devolve o resultado original em vez de executar de novo,
 * então nenhum efeito externo é duplicado. Operação já confirmada só conclui o
 * lado local, sem tocar o provedor. Nunca marca sucesso sem confirmação.
 */
export async function reconcilePayoutOperations(
  svc: any,
  options: {
    limit?: number;
    provider?: ProviderFn;
    applyLocal?: ApplyLocalFn;
    nowMs?: number;
    graceMs?: number;
  } = {},
): Promise<{ examined: number; confirmed: number; failed: number; divergent: number; pending: number; localApplied: number; unavailable: number }> {
  const out = { examined: 0, confirmed: 0, failed: 0, divergent: 0, pending: 0, localApplied: 0, unavailable: 0 };
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const graceMs = Number.isFinite(options.graceMs) ? Number(options.graceMs) : PAYOUT_OPERATION_GRACE_MS;
  const provider = options.provider || defaultProvider;
  const applyLocal = options.applyLocal || ((op: any) => defaultApplyLocal(svc, op));

  let rows: any[] = [];
  try {
    rows = await svc.entities[ENTITY].filter(
      { state: { $in: ["intent_recorded", "reconciliation_required"] }, is_deleted: false },
      "created_date",
      Math.max(1, Math.min(Number(options.limit) || 25, 100)),
    );
  } catch (err: any) {
    console.error("[payoutOperation] varredura falhou:", err?.message || err);
    out.unavailable++;
    return out;
  }
  if (!Array.isArray(rows)) {
    out.unavailable++;
    return out;
  }

  for (const op of rows) {
    out.examined++;
    const createdAtMs = op.requested_at
      ? new Date(op.requested_at).getTime()
      : (op.created_date ? new Date(op.created_date).getTime() : 0);
    if (op.state === "intent_recorded" && createdAtMs && nowMs - createdAtMs < graceMs) {
      // Pode estar em andamento agora: não interfere.
      out.pending++;
      continue;
    }

    try {
      // Já confirmado no provedor: apenas conclui o lado local.
      if (op.provider_reference) {
        const applied = await applyLocal(op);
        if (!applied.applied) {
          out.pending++;
          continue;
        }
        await transition(svc, op.id, { local_applied: true, settled_by: "reconciliation", last_error: "" }, FROM_ANY_OPEN);
        await writeResultTrail(svc, op, "provider_confirmed", { local_aplicado: true, reconciliado: true });
        out.confirmed++;
        out.localApplied++;
        continue;
      }

      // Trilha da intenção: garante correlação mesmo quando a original falhou.
      try { await writeIntentTrail(svc, op, { reconciliado: true }); } catch { /* segue: a trilha de resultado também cobre */ }

      await bumpAttempts(svc, op.id);
      const outcome = await provider(op);

      if (outcome.outcome === "failed") {
        const divergent = outcome.errorCode === "idempotency_conflict";
        await transition(svc, op.id, {
          state: divergent ? "divergent" : "provider_failed",
          provider_status: outcome.errorCode,
          provider_error: outcome.message,
          settled_by: "reconciliation",
        });
        await writeResultTrail(svc, op, divergent ? "divergent" : "provider_failed", { reconciliado: true });
        if (divergent) out.divergent++;
        else out.failed++;
        continue;
      }
      if (outcome.outcome === "unknown") {
        await transition(svc, op.id, {
          state: "reconciliation_required",
          provider_status: outcome.errorCode,
          provider_error: outcome.message,
          settled_by: "reconciliation",
        });
        out.pending++;
        continue;
      }

      const confirmedOp = { ...op, provider_reference: outcome.reference, provider_status: outcome.status };
      await transition(svc, op.id, {
        state: "provider_confirmed",
        provider_reference: outcome.reference,
        provider_status: outcome.status,
        provider_error: "",
        settled_by: "reconciliation",
      });
      const applied = await applyLocal(confirmedOp);
      if (!applied.applied) {
        await transition(svc, op.id, { state: "reconciliation_required", last_error: applied.error || "estado_local_nao_confirmado" }, FROM_CONFIRMED);
        out.pending++;
        continue;
      }
      await transition(svc, op.id, { local_applied: true, last_error: "" }, FROM_CONFIRMED);
      await writeResultTrail(svc, confirmedOp, "provider_confirmed", { local_aplicado: true, reconciliado: true });
      out.confirmed++;
      out.localApplied++;
    } catch (err: any) {
      console.error("[payoutOperation] reconciliação da operação falhou:", op?.id, err?.message || err);
      out.unavailable++;
    }
  }

  return out;
}

export { TERMINAL_STATES };
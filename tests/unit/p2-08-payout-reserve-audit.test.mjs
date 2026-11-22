// P2-08 (2026-11-22) — CICLO RASTREÁVEL DA OPERAÇÃO DE REPASSE.
//
// Defeito original: `Math.max(0, Number(amount) || 0)` transformava qualquer
// entrada inválida em valor válido em silêncio e a trilha registrava apenas
// "solicitada" — sem prova do desfecho. Um timeout, uma confirmação do provedor
// com gravação local falha ou uma recusa explícita ficavam indistinguíveis.
//
// Contrato testado aqui:
//   • dinheiro validado (finito, não negativo, até 2 casas) antes de qualquer efeito;
//   • intenção durável (PayoutOperation) + trilha da intenção ANTES do provedor;
//   • três desfechos do provedor: confirmado, recusado e DESCONHECIDO;
//   • só `provider_confirmed` aplica o local, e só depois de confirmado por leitura;
//   • replay e reconciliação reusam a MESMA idempotency key (nenhum efeito duplo).

import test from "node:test";
import assert from "node:assert/strict";

import managePayouts from "../../base44/functions/managePayouts/entry.ts";
import {
  buildPayoutIdempotencyKey,
  reconcilePayoutOperations,
} from "../../base44/shared/payoutOperation.ts";
import { makeHttpClient, invoke } from "./lib/fakeHttpClient.mjs";
import { createFakeDb } from "./lib/fakeDb.mjs";

const MANAGER = { id: "u_mgr", role: "user", email: "mgr@example.com", full_name: "Gestor do Evento" };
const TEAM = { id: "u_team", role: "user", email: "team@example.com", full_name: "Equipe" };

function payoutClient(user = MANAGER, faults = {}) {
  const memberships = [
    { event_id: "evt_1", user_id: "u_mgr", role: "manager", is_active: true, is_deleted: false },
    { event_id: "evt_1", user_id: "u_team", role: "team", is_active: true, is_deleted: false },
  ];
  return makeHttpClient({
    user,
    faults,
    collections: {
      User: [user],
      Event: [{ id: "evt_1", name: "Evolve Summit", status: "active", manager_id: "u_mgr", is_deleted: false }],
      EventMembership: memberships,
      PayoutAccount: [{
        id: "pa_1",
        manager_user_id: "u_mgr",
        manager_name: "Gestor do Evento",
        legal_name: "Evolve Ltda",
        stripe_account_id: "acct_1",
        status: "verified",
        charges_enabled: true,
        payouts_enabled: true,
        reserve_amount: 0,
        requirements_json: "",
        is_deleted: false,
      }],
      EventFinance: [],
      PlatformSetting: [],
      AuditLog: [],
      PayoutOperation: [],
    },
  });
}

// Stub do Stripe: nenhuma chamada real. `calls` registra URL, corpo e a chave de
// idempotência de cada requisição.
function stubStripe(behaviour = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    calls.push({
      url: String(url),
      body: decodeURIComponent(String(init.body || "")),
      idempotencyKey: String(headers["Idempotency-Key"] || headers["idempotency-key"] || ""),
    });
    if (behaviour.throws) throw new Error("socket hang up");
    const status = behaviour.status || 200;
    const payload = status >= 400
      ? { error: { type: behaviour.type || "invalid_request_error", message: behaviour.message || "conta inválida" } }
      : { id: "acct_1", object: "account" };
    return { ok: status < 400, status, json: async () => payload };
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

const body = (over = {}) => ({ action: "setReserve", eventId: "evt_1", amount: "12.50", ...over });

const operationOf = (client) => client.rows.PayoutOperation[0] || null;
const auditTypes = (client) => client.rows.AuditLog.map((a) => JSON.parse(a.details).type);

test("valor válido: centavos ao provedor, intenção confirmada, local confirmado por leitura", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient();
    const res = await invoke(managePayouts, client.base44, body({ reason: "reserva mínima" }));

    assert.equal(res.status, 200);
    assert.equal(res.data.account.reserve_amount, 12.5);
    assert.ok(res.data.correlation_id, "a resposta carrega o id de correlação");
    assert.equal(res.data.operation.state, "provider_confirmed");

    // Provedor: um único POST, valor em centavos e chave determinística.
    assert.equal(stripe.calls.length, 1);
    assert.match(stripe.calls[0].url, /\/accounts\/acct_1$/);
    assert.match(stripe.calls[0].body, /minimum_balance\]=1250/);
    assert.match(stripe.calls[0].body, /debit_negative_balances\]=true/);
    assert.equal(stripe.calls[0].idempotencyKey, buildPayoutIdempotencyKey("pa_1", 1250));

    // Operação durável com desfecho e confirmação local.
    const op = operationOf(client);
    assert.equal(op.state, "provider_confirmed");
    assert.equal(op.local_applied, true);
    assert.equal(op.amount_cents, 1250);
    assert.equal(op.idempotency_key, buildPayoutIdempotencyKey("pa_1", 1250));
    assert.equal(op.provider_reference, "acct_1");
    assert.equal(op.attempts, 1);
    assert.equal(op.settled_by, "request");
    assert.equal(op.correlation_id, op.operation_id);
    assert.equal(op.actor_user_id, "u_mgr");

    // Duas trilhas obrigatórias: intenção e resultado.
    assert.deepEqual(auditTypes(client), ["reserva_saldo_alterada", "reserva_saldo_resultado"]);
    const intent = JSON.parse(client.rows.AuditLog[0].details);
    assert.equal(intent.estado, "intent_recorded");
    assert.equal(intent.valor_anterior, 0);
    assert.equal(intent.valor_novo, 12.5);
    assert.equal(intent.valor_centavos, 1250);
    assert.equal(intent.motivo, "reserva mínima");
    assert.equal(intent.operation_id, op.operation_id);
    const result = JSON.parse(client.rows.AuditLog[1].details);
    assert.equal(result.estado, "provider_confirmed");
    assert.equal(result.local_aplicado, true);
    assert.equal(result.referencia_provedor, "acct_1");
    assert.equal(client.rows.AuditLog[1].mandatory, true);
    assert.equal(client.rows.AuditLog[1].status, "recorded");
  } finally {
    stripe.restore();
  }
});

test("ordem: intenção durável e trilha ANTES do efeito externo", async () => {
  const order = [];
  const stripe = stubStripe();
  try {
    const client = payoutClient();
    const createOp = client.entities.PayoutOperation.create;
    client.entities.PayoutOperation.create = async (data) => {
      order.push("intent");
      return createOp(data);
    };
    const auditCreate = client.entities.AuditLog.create;
    client.entities.AuditLog.create = async (data) => {
      order.push(JSON.parse(data.details).type);
      return auditCreate(data);
    };
    const fetchStub = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      order.push("stripe");
      return fetchStub(url, init);
    };

    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 200);
    assert.deepEqual(order, ["intent", "reserva_saldo_alterada", "stripe", "reserva_saldo_resultado"]);
  } finally {
    stripe.restore();
  }
});

test("entradas inválidas são RECUSADAS sem tocar o provedor nem criar operação", async () => {
  const stripe = stubStripe();
  try {
    for (const amount of ["abc", -5, "12.345", 12.345, "", undefined, NaN]) {
      const client = payoutClient();
      const res = await invoke(managePayouts, client.base44, body({ amount }));
      assert.equal(res.status, 400, `amount ${String(amount)} deveria ser recusado`);
      assert.equal(res.data.field, "amount");
      assert.equal(client.rows.PayoutAccount[0].reserve_amount, 0, "nenhum valor é ajustado em silêncio");
      assert.equal(client.rows.AuditLog.length, 0, "sem efeito, sem trilha");
      assert.equal(client.rows.PayoutOperation.length, 0, "sem efeito, sem intenção");
    }
    assert.equal(stripe.calls.length, 0, "nada chega ao Stripe");
  } finally {
    stripe.restore();
  }
});

test("zero é um valor válido (remoção da reserva)", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient();
    client.rows.PayoutAccount[0].reserve_amount = 30;
    const res = await invoke(managePayouts, client.base44, body({ amount: 0 }));
    assert.equal(res.status, 200);
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 0);
    // Sem mínimo positivo o parâmetro de saldo não é enviado.
    assert.doesNotMatch(stripe.calls[0].body, /minimum_balance/);
    assert.match(stripe.calls[0].body, /debit_negative_balances\]=true/);
    assert.equal(JSON.parse(client.rows.AuditLog[0].details).valor_anterior, 30);
    assert.equal(operationOf(client).amount_cents, 0);
  } finally {
    stripe.restore();
  }
});

test("trilha da intenção indisponível: 503, provedor NÃO é chamado e a operação registra o motivo", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient(MANAGER, { "AuditLog.create": true });
    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 503);
    assert.match(res.data.error, /trilha/i);
    assert.equal(stripe.calls.length, 0, "sem trilha, nenhum efeito externo");
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 0);
    const op = operationOf(client);
    assert.equal(op.state, "provider_failed");
    assert.equal(op.provider_status, "audit_unavailable");
    assert.equal(op.attempts, 0, "o provedor não foi chamado");
  } finally {
    stripe.restore();
  }
});

test("provedor RECUSA (4xx): 502, operação provider_failed e valor local intacto", async () => {
  const stripe = stubStripe({ status: 400, message: "conta inválida" });
  try {
    const client = payoutClient();
    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 502);
    assert.match(res.data.error, /conta inválida/);
    assert.equal(res.data.operation.state, "provider_failed");
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 0, "resposta otimista não é persistida");
    const op = operationOf(client);
    assert.equal(op.state, "provider_failed");
    assert.equal(op.local_applied, false);
    assert.match(op.provider_error, /conta inválida/);
    assert.deepEqual(auditTypes(client), ["reserva_saldo_alterada", "reserva_saldo_resultado"]);
    assert.equal(JSON.parse(client.rows.AuditLog[1].details).estado, "provider_failed");
  } finally {
    stripe.restore();
  }
});

test("provedor SEM RESPOSTA (timeout/rede): 503, reconciliation_required — nunca tratado como falha", async () => {
  const stripe = stubStripe({ throws: true });
  try {
    const client = payoutClient();
    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 503, "o chamador não pode tratar como concluído");
    assert.equal(res.data.reconciliation, "automatic");
    const op = operationOf(client);
    assert.equal(op.state, "reconciliation_required", "resultado desconhecido não é falha");
    assert.equal(op.provider_status, "provider_unreachable");
    assert.equal(op.local_applied, false, "nada é aplicado sem confirmação");
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 0);
  } finally {
    stripe.restore();
  }
});

test("provedor com 5xx: também é resultado DESCONHECIDO (reconciliation_required)", async () => {
  const stripe = stubStripe({ status: 503, message: "upstream indisponível" });
  try {
    const client = payoutClient();
    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 503);
    assert.equal(operationOf(client).state, "reconciliation_required");
    assert.equal(operationOf(client).provider_status, "provider_error_5xx");
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 0);
  } finally {
    stripe.restore();
  }
});

test("conflito de idempotência: 409 DIVERGENTE (revisão humana, nunca nova tentativa)", async () => {
  const stripe = stubStripe({ status: 409, type: "idempotency_error", message: "chave já usada com outros parâmetros" });
  try {
    const client = payoutClient();
    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 409);
    assert.equal(res.data.reconciliation, "manual");
    assert.equal(operationOf(client).state, "divergent");
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 0);
    assert.equal(JSON.parse(client.rows.AuditLog[1].details).estado, "divergent");
  } finally {
    stripe.restore();
  }
});

test("provedor CONFIRMA mas o local não confirma: 503 e a operação fica pendente de reconciliação", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient(MANAGER, { "PayoutAccount.update": true });
    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 503);
    assert.equal(res.data.reconciliation, "automatic");
    assert.equal(stripe.calls.length, 1, "o efeito externo aconteceu e é preservado");
    const op = operationOf(client);
    assert.equal(op.provider_reference, "acct_1", "a referência do provedor não é perdida");
    assert.equal(op.state, "reconciliation_required");
    assert.equal(op.local_applied, false);
    assert.match(op.last_error, /escrita_local_falhou/);
  } finally {
    stripe.restore();
  }
});

test("replay da MESMA operação: nenhum segundo efeito externo e nenhuma trilha duplicada", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient();
    const first = await invoke(managePayouts, client.base44, body());
    assert.equal(first.status, 200);
    assert.equal(client.rows.AuditLog.length, 2);

    const second = await invoke(managePayouts, client.base44, body());
    assert.equal(second.status, 200, "a operação já confirmada responde sem repetir nada");
    assert.equal(stripe.calls.length, 1, "a chave determinística impediu o segundo POST");
    assert.equal(client.rows.AuditLog.length, 2, "mesma operação, mesma trilha");
    assert.equal(client.rows.PayoutOperation.length, 1);
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 12.5);
  } finally {
    stripe.restore();
  }
});

test("valor diferente gera operação e trilha próprias", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient();
    await invoke(managePayouts, client.base44, body({ amount: "10.00" }));
    await invoke(managePayouts, client.base44, body({ amount: "20.00" }));
    assert.equal(client.rows.PayoutOperation.length, 2);
    assert.equal(client.rows.AuditLog.length, 4);
    assert.equal(stripe.calls.length, 2);
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 20);
  } finally {
    stripe.restore();
  }
});

test("membro da equipe (não financeiro) é barrado — FIN-003", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient(TEAM);
    client.rows.User.push(TEAM);
    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 403);
    assert.match(res.data.error, /financeir/i);
    assert.equal(stripe.calls.length, 0);
    assert.equal(client.rows.AuditLog.length, 0);
    assert.equal(client.rows.PayoutOperation.length, 0);
  } finally {
    stripe.restore();
  }
});

test("sem conta conectada não há reserva a configurar", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient();
    client.rows.PayoutAccount[0].stripe_account_id = "";
    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 404);
    assert.equal(stripe.calls.length, 0);
  } finally {
    stripe.restore();
  }
});

// ===== RECONCILIAÇÃO (expireStaleReservations) =====

function opRow(over = {}) {
  return {
    id: "op_1",
    operation_id: "op_uuid_1",
    idempotency_key: buildPayoutIdempotencyKey("pa_1", 1250),
    operation_type: "payout_reserve",
    event_id: "evt_1",
    account_id: "pa_1",
    stripe_account_id: "acct_1",
    actor_user_id: "u_mgr",
    amount_cents: 1250,
    amount_brl: 12.5,
    previous_brl: 0,
    currency: "BRL",
    state: "reconciliation_required",
    provider: "stripe",
    provider_reference: "",
    local_applied: false,
    attempts: 1,
    requested_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    is_deleted: false,
    ...over,
  };
}

function reconcileDb(operations) {
  return createFakeDb({
    payoutAccounts: [{ id: "pa_1", stripe_account_id: "acct_1", reserve_amount: 0, is_deleted: false }],
    payoutOperations: operations,
    auditLogs: [],
  });
}

test("reconciliação reenvia a MESMA chave e conclui o local (sem segundo efeito)", async () => {
  const db = reconcileDb([opRow()]);
  const keys = [];
  const out = await reconcilePayoutOperations(db.svc, {
    provider: async (op) => {
      keys.push(op.idempotency_key);
      return { outcome: "confirmed", reference: "acct_1", status: "account" };
    },
  });
  assert.equal(out.confirmed, 1);
  assert.equal(out.localApplied, 1);
  assert.deepEqual(keys, [buildPayoutIdempotencyKey("pa_1", 1250)], "a mesma chave, nunca uma nova");
  const op = db.payoutOperations[0];
  assert.equal(op.state, "provider_confirmed");
  assert.equal(op.local_applied, true);
  assert.equal(op.settled_by, "reconciliation");
  assert.equal(db.payoutAccounts[0].reserve_amount, 12.5);
});

test("reconciliação de operação já confirmada no provedor NÃO chama o provedor de novo", async () => {
  const db = reconcileDb([opRow({ state: "reconciliation_required", provider_reference: "acct_1" })]);
  let called = 0;
  const out = await reconcilePayoutOperations(db.svc, {
    provider: async () => { called++; return { outcome: "confirmed", reference: "acct_1", status: "account" }; },
  });
  assert.equal(called, 0, "o efeito externo já existe: só o lado local é concluído");
  assert.equal(out.localApplied, 1);
  assert.equal(db.payoutOperations[0].local_applied, true);
  assert.equal(db.payoutAccounts[0].reserve_amount, 12.5);
});

test("reconciliação respeita a janela de tolerância da intenção em andamento", async () => {
  const db = reconcileDb([opRow({ state: "intent_recorded", requested_at: new Date().toISOString() })]);
  let called = 0;
  const out = await reconcilePayoutOperations(db.svc, {
    provider: async () => { called++; return { outcome: "confirmed", reference: "acct_1", status: "account" }; },
  });
  assert.equal(called, 0, "não interfere numa requisição que pode estar em curso");
  assert.equal(out.pending, 1);
  assert.equal(db.payoutOperations[0].state, "intent_recorded");
});

test("reconciliação que recebe resultado DESCONHECIDO mantém a operação pendente", async () => {
  const db = reconcileDb([opRow()]);
  const out = await reconcilePayoutOperations(db.svc, {
    provider: async () => ({ outcome: "unknown", errorCode: "provider_unreachable", message: "timeout" }),
  });
  assert.equal(out.pending, 1);
  assert.equal(db.payoutOperations[0].state, "reconciliation_required");
  assert.equal(db.payoutAccounts[0].reserve_amount, 0, "nada é aplicado sem confirmação");
});

test("reconciliação com leitura indisponível não declara nada concluído", async () => {
  const db = reconcileDb([opRow()]);
  db.svc.entities.PayoutOperation.filter = async () => { throw new Error("leitura indisponível"); };
  let called = 0;
  const out = await reconcilePayoutOperations(db.svc, {
    provider: async () => { called++; return { outcome: "confirmed", reference: "acct_1", status: "account" }; },
  });
  assert.equal(called, 0);
  assert.equal(out.unavailable, 1);
  assert.equal(db.payoutAccounts[0].reserve_amount, 0);
});
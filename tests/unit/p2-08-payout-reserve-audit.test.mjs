// P2-08 (2026-11-22) — RESERVA DE REPASSE: VALOR VALIDADO E TRILHA OBRIGATÓRIA.
//
// Defeito original: `Math.max(0, Number(amount) || 0)` transformava qualquer
// entrada inválida em valor válido em silêncio ("abc" → 0, NaN → 0, -5 → 0) e a
// alteração era aplicada no Stripe e no registro local SEM trilha obrigatória —
// sem saber quem alterou, qual era o valor anterior nem o motivo.
//
// Agora: dinheiro validado (finito, não negativo, até 2 casas, limite de
// negócio), trilha gravada ANTES do efeito externo e confirmação por LEITURA.

import test from "node:test";
import assert from "node:assert/strict";

import managePayouts from "../../base44/functions/managePayouts/entry.ts";
import { makeHttpClient, invoke } from "./lib/fakeHttpClient.mjs";

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
    },
  });
}

// Stub do Stripe: nenhuma chamada real. `calls` registra o que foi enviado.
function stubStripe({ ok = true, error = "invalid account" } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    // O corpo vai em x-www-form-urlencoded: decodifica para as asserções lerem
    // `settings[payouts][minimum_balance]`.
    calls.push({ url: String(url), body: decodeURIComponent(String(init.body || "")) });
    return ok
      ? { ok: true, status: 200, json: async () => ({ id: "acct_1", object: "account" }) }
      : { ok: false, status: 400, json: async () => ({ error: { message: error } }) };
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
  };
}

const body = (over = {}) => ({ action: "setReserve", eventId: "evt_1", amount: "12.50", ...over });

test("valor válido: Stripe recebe centavos, registro confirma e a trilha é obrigatória", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient();
    const res = await invoke(managePayouts, client.base44, body({ reason: "reserva mínima" }));

    assert.equal(res.status, 200);
    assert.equal(res.data.account.reserve_amount, 12.5);
    assert.ok(res.data.correlation_id, "a resposta carrega o id de correlação");

    assert.equal(stripe.calls.length, 1);
    assert.match(stripe.calls[0].url, /\/accounts\/acct_1$/);
    assert.match(stripe.calls[0].body, /minimum_balance\]=1250/);
    assert.match(stripe.calls[0].body, /debit_negative_balances\]=true/);

    const audits = client.rows.AuditLog;
    assert.equal(audits.length, 1);
    const audit = audits[0];
    assert.equal(audit.mandatory, true);
    assert.equal(audit.status, "recorded");
    assert.equal(audit.provider, "stripe");
    assert.equal(audit.entity_type, "PayoutAccount");
    assert.equal(audit.entity_id, "pa_1");
    assert.equal(audit.user_id, "u_mgr");
    assert.equal(audit.event_id, "evt_1");
    assert.ok(audit.audit_key, "chave determinística da operação");
    const details = JSON.parse(audit.details);
    assert.equal(details.type, "reserva_saldo_alterada");
    assert.equal(details.valor_anterior, 0);
    assert.equal(details.valor_novo, 12.5);
    assert.equal(details.motivo, "reserva mínima");
    assert.equal(details.resultado, "solicitada");
    assert.equal(details.correlation_id, res.data.correlation_id);
  } finally {
    stripe.restore();
  }
});

test("a trilha é gravada ANTES do efeito no provedor", async () => {
  const order = [];
  const stripe = stubStripe();
  try {
    const client = payoutClient();
    const auditCreate = client.entities.AuditLog.create;
    client.entities.AuditLog.create = async (data) => {
      order.push("audit");
      return auditCreate(data);
    };
    const fetchStub = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      order.push("stripe");
      return fetchStub(url, init);
    };

    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 200);
    assert.deepEqual(order, ["audit", "stripe"]);
  } finally {
    stripe.restore();
  }
});

test("entradas inválidas são RECUSADAS sem tocar o provedor", async () => {
  const stripe = stubStripe();
  try {
    for (const amount of ["abc", -5, "12.345", 12.345, "", undefined, NaN]) {
      const client = payoutClient();
      const res = await invoke(managePayouts, client.base44, body({ amount }));
      assert.equal(res.status, 400, `amount ${String(amount)} deveria ser recusado`);
      assert.equal(res.data.field, "amount");
      assert.equal(client.rows.PayoutAccount[0].reserve_amount, 0, "nenhum valor é ajustado em silêncio");
      assert.equal(client.rows.AuditLog.length, 0, "sem efeito, sem trilha");
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
  } finally {
    stripe.restore();
  }
});

test("trilha indisponível BLOQUEIA a alteração (503, nada muda no provedor)", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient(MANAGER, { "AuditLog.create": true });
    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 503);
    assert.match(res.data.error, /trilha/i);
    assert.equal(stripe.calls.length, 0, "sem trilha, nenhum efeito externo");
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 0);
  } finally {
    stripe.restore();
  }
});

test("falha do provedor: 502, valor local intacto e trilha registra a solicitação", async () => {
  const stripe = stubStripe({ ok: false, error: "conta inválida" });
  try {
    const client = payoutClient();
    const res = await invoke(managePayouts, client.base44, body());
    assert.equal(res.status, 502);
    assert.match(res.data.error, /conta inválida/);
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 0, "resposta otimista não é persistida");
    assert.equal(client.rows.AuditLog.length, 1, "a tentativa fica na trilha");
    assert.equal(JSON.parse(client.rows.AuditLog[0].details).resultado, "solicitada");
  } finally {
    stripe.restore();
  }
});

test("retry da MESMA operação não duplica a trilha (chave determinística)", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient();
    const first = await invoke(managePayouts, client.base44, body());
    assert.equal(first.status, 200);
    assert.equal(client.rows.AuditLog.length, 1);

    // Retry com o estado anterior idêntico (0 → 12,50): a chave da operação é a
    // mesma, então a trilha já gravada é reconhecida em vez de duplicada.
    client.rows.PayoutAccount[0].reserve_amount = 0;
    const second = await invoke(managePayouts, client.base44, body());
    assert.equal(second.status, 200);
    assert.equal(client.rows.AuditLog.length, 1, "mesma operação, mesma trilha");
    assert.equal(client.rows.PayoutAccount[0].reserve_amount, 12.5);
  } finally {
    stripe.restore();
  }
});

test("valor diferente gera trilha própria", async () => {
  const stripe = stubStripe();
  try {
    const client = payoutClient();
    await invoke(managePayouts, client.base44, body({ amount: "10.00" }));
    await invoke(managePayouts, client.base44, body({ amount: "20.00" }));
    assert.equal(client.rows.AuditLog.length, 2);
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
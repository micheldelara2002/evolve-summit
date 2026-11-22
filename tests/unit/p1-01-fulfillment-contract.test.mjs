// P1-01 (F4-06) — contrato de fulfillment: nenhum caminho declara conclusão
// sem verificação, e 'fulfilling' nunca é lido como 'fulfilled'.

import test from "node:test";
import assert from "node:assert/strict";

import { createFakeDb } from "./lib/fakeDb.mjs";
import { fulfillOrder, verifyFulfillmentComplete } from "../../base44/shared/commerceFulfillment.ts";

function setup({ payment = {}, itemCount = 2, tickets = [], participants = [] } = {}) {
  const orderItems = Array.from({ length: itemCount }, (_, i) => ({
    id: `oi_${i + 1}`,
    order_id: "ord_1",
    event_id: "ev_1",
    ticket_type_id: "tt_1",
    lot_id: "lot_1",
    ticket_type_name: "Ingresso",
    holder_name: `Pessoa ${i + 1}`,
    holder_email: `pessoa${i + 1}@example.com`,
    is_deleted: false,
  }));
  const db = createFakeDb({
    payments: [{
      id: "pay_1",
      order_id: "ord_1",
      event_id: "ev_1",
      intent_id: "pi_1",
      amount: 100,
      amount_cents: 10000,
      currency: "BRL",
      status: "succeeded",
      refunded_amount: 0,
      fulfillment_status: "pending",
      updated_date: new Date().toISOString(),
      ...payment,
    }],
    orders: [{
      id: "ord_1",
      event_id: "ev_1",
      buyer_user_id: "u_1",
      buyer_person_id: "person_buyer",
      status: "pending",
      total: 100,
      fulfillment_status: "pending",
      created_date: new Date().toISOString(),
      is_deleted: false,
    }],
    orderItems,
    tickets,
    participants,
    persons: [{ id: "person_buyer", contact_email: "buyer@example.com", is_active: true }],
    events: [{ id: "ev_1", name: "Evento" }],
  });
  const paymentRow = { ...db.payments[0] };
  const orderRow = { ...db.orders[0] };
  return { db, orderItems, paymentRow, orderRow };
}

test("P1-01 — emissão completa: fulfilled verificado", async () => {
  const { db, orderItems, paymentRow, orderRow } = setup();
  const out = await fulfillOrder(db.svc, paymentRow, orderRow, orderItems);

  assert.equal(out.state, "fulfilled");
  assert.equal(out.fulfilled, true);
  assert.equal(out.in_progress, false);
  assert.equal(db.tickets.length, 2, "um ingresso por item");
  assert.ok(db.tickets.every((t) => !!t.participant_id), "todo ingresso vinculado ao participante");
  assert.equal(db.payments[0].fulfillment_status, "fulfilled");
});

test("P1-01 — 'fulfilling' recente NUNCA é reportado como fulfilled", async () => {
  const { db, orderItems, orderRow } = setup({
    payment: { fulfillment_status: "fulfilling", updated_date: new Date().toISOString() },
  });
  const out = await fulfillOrder(db.svc, { ...db.payments[0] }, orderRow, orderItems);

  assert.equal(out.state, "fulfilling");
  assert.equal(out.fulfilled, false, "processo concorrente em andamento não é conclusão");
  assert.equal(out.in_progress, true);
  assert.equal(db.tickets.length, 0, "não concorre com o processo vivo");
});

test("P1-01 — claim não adquirido com estado não concluído → pending_retry", async () => {
  const { db, orderItems, orderRow } = setup({
    payment: { status: "expired", fulfillment_status: "pending" },
  });
  const out = await fulfillOrder(db.svc, { ...db.payments[0] }, orderRow, orderItems);

  assert.equal(out.fulfilled, false);
  assert.equal(out.state, "pending_retry");
  assert.match(String(out.error), /Claim de emissão não adquirido/);
  assert.equal(db.tickets.length, 0);
});

test("P1-01 — 20 chamadas concorrentes: no máximo uma emite, nenhum duplicado", async () => {
  const { db, orderItems, orderRow } = setup({ itemCount: 3 });
  const paymentSnapshot = { ...db.payments[0] };

  const results = await Promise.all(
    Array.from({ length: 20 }, () => fulfillOrder(db.svc, { ...paymentSnapshot }, { ...orderRow }, orderItems)),
  );

  const fulfilled = results.filter((r) => r.fulfilled);
  assert.equal(fulfilled.length, 1, "exatamente uma chamada conclui a emissão");
  assert.equal(db.tickets.length, 3, "nenhum ingresso duplicado");
  const byItem = new Map();
  for (const t of db.tickets) byItem.set(t.order_item_id, (byItem.get(t.order_item_id) || 0) + 1);
  assert.ok([...byItem.values()].every((n) => n === 1), "um ingresso por item");
  for (const r of results) {
    assert.equal(r.fulfilled, r.state === "fulfilled", "fulfilled só é true quando o estado é fulfilled");
    if (r.state === "fulfilling") assert.equal(r.in_progress, true);
  }
  assert.ok(results.some((r) => !r.fulfilled), "as demais chamadas não declaram conclusão");
});

test("P1-01 — 'fulfilled' persistido sem emissão completa é reaberto e recuperado", async () => {
  const { db, orderItems, orderRow } = setup({
    payment: { fulfillment_status: "fulfilled" },
  });
  const out = await fulfillOrder(db.svc, { ...db.payments[0] }, orderRow, orderItems);

  assert.equal(out.state, "fulfilled", "a retomada emite o que faltava");
  assert.equal(db.tickets.length, 2);
  assert.ok(db.tickets.every((t) => !!t.participant_id));
});

test("P1-01 — crash após criar ingresso, antes de vincular participante: repara e só então conclui", async () => {
  const { db, orderItems, orderRow } = setup({
    itemCount: 2,
    payment: { fulfillment_status: "pending_retry" },
    tickets: [{
      id: "tk_1",
      order_id: "ord_1",
      order_item_id: "oi_1",
      event_id: "ev_1",
      lot_id: "lot_1",
      person_id: "person_orphan",
      participant_id: "",
      holder_name: "Pessoa 1",
      holder_email: "pessoa1@example.com",
      hash_code: "hash_1",
      status: "issued",
      is_deleted: false,
    }],
  });
  const out = await fulfillOrder(db.svc, { ...db.payments[0] }, orderRow, orderItems);

  assert.equal(out.state, "fulfilled");
  assert.equal(db.tickets.length, 2, "não duplica o ingresso existente");
  assert.ok(db.tickets.every((t) => !!t.participant_id), "ingresso órfão foi vinculado");
});

test("P1-01 — pedido cancelado → failed (nunca fulfilled)", async () => {
  const { db, orderItems } = setup();
  const out = await fulfillOrder(db.svc, { ...db.payments[0] }, { ...db.orders[0], status: "cancelled" }, orderItems);

  assert.equal(out.state, "failed");
  assert.equal(out.fulfilled, false);
  assert.equal(db.tickets.length, 0);
});

test("P1-01 — verifyFulfillmentComplete exige ingresso por item e participante vinculado", async () => {
  const { db, orderItems } = setup({ itemCount: 2 });
  const missing = await verifyFulfillmentComplete(db.svc, "ord_1", orderItems);
  assert.equal(missing.complete, false);
  assert.match(String(missing.reason), /ingressos_ausentes/);

  db.tickets.push(
    { id: "tk_1", order_id: "ord_1", order_item_id: "oi_1", participant_id: "pt_1", is_deleted: false },
    { id: "tk_2", order_id: "ord_1", order_item_id: "oi_2", participant_id: "", is_deleted: false },
  );
  const orphan = await verifyFulfillmentComplete(db.svc, "ord_1", orderItems);
  assert.equal(orphan.complete, false);
  assert.match(String(orphan.reason), /participantes_nao_vinculados/);

  db.tickets[1].participant_id = "pt_2";
  const ok = await verifyFulfillmentComplete(db.svc, "ord_1", orderItems);
  assert.equal(ok.complete, true);
});

test("P1-01 — retry após conclusão continua idempotente", async () => {
  const { db, orderItems, orderRow } = setup();
  const first = await fulfillOrder(db.svc, { ...db.payments[0] }, orderRow, orderItems);
  const second = await fulfillOrder(db.svc, { ...db.payments[0] }, orderRow, orderItems);

  assert.equal(first.state, "fulfilled");
  assert.equal(second.state, "fulfilled");
  assert.equal(db.tickets.length, 2, "retry não duplica ingressos");
});
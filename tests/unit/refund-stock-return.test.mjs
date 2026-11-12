// P1.1 (patch Fase 1, 2026-11-12) — DEVOLUÇÃO DE ESTOQUE: COMPROVAÇÃO POSITIVA.
//
// Alvo: returnSoldQuantityOnce (base44/shared/commerceFulfillment.ts) e o seu
// efeito no caminho completo (applyConfirmedStripeRefund → processRefundSuccess).
//
// Prova: nenhum caminho declara sucesso na devolução sem comprovar que a unidade
// foi decrementada+registrada atomicamente, ou que já estava registrada por uma
// execução anterior. Zero atualização, isoladamente, NÃO é prova de devolução.
// NÃO prova: concorrência real de banco nem atomicidade do documento no MongoDB.
//
// Execução: npm run test:unit:refund

import test from "node:test";
import assert from "node:assert/strict";

import { createFakeDb, basePayment } from "./lib/fakeDb.mjs";
import {
  applyConfirmedStripeRefund,
  returnSoldQuantityOnce,
} from "../../base44/shared/commerceFulfillment.ts";

const REQ = "req_A";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Faz o CAS devolver zero SEM aplicar nada e SEM falhar — o caso ambíguo que a
// correção precisa recusar (lote inexistente/corrida). Conta sozinho quantas
// tentativas de decremento foram feitas.
function zeroWithoutError(db) {
  const collection = db.svc.entities.SalesLot;
  const real = collection.updateMany.bind(collection);
  let calls = 0;
  collection.updateMany = async () => { calls += 1; return { updated: 0 }; };
  return {
    calls: () => calls,
    restore: () => { collection.updateMany = real; },
  };
}

function breakRead(db, message = "leitura indisponível") {
  const collection = db.svc.entities.SalesLot;
  const real = collection.filter.bind(collection);
  collection.filter = async () => { throw new Error(message); };
  return () => { collection.filter = real; };
}

function stockDb(lots) {
  return createFakeDb({ salesLots: lots });
}

function refundFixture({ quantitySold = 1, returned } = {}) {
  const lot = { id: "lot_1", quantity_sold: quantitySold };
  if (returned) lot.stock_returned_ticket_ids = returned;
  return createFakeDb({
    payments: [basePayment({
      refunded_cents: 0,
      refund_reserved_cents: 10000,
      refund_committed_cents: 10000,
      refund_reservation_ids: [REQ],
      refunded_amount: 0,
    })],
    refundRequests: [{
      id: REQ, payment_id: "pay_1", order_id: "ord_1", event_id: "ev_1",
      status: "approved", refund_type: "full", amount_requested: 100,
      requested_by_user_id: "u1", stripe_refund_id: "re_1", is_deleted: false,
    }],
    orders: [{ id: "ord_1", event_id: "ev_1", buyer_user_id: "u1", status: "paid", total: 100 }],
    orderItems: [{ id: "oi_1", order_id: "ord_1", refunded: false, is_deleted: false }],
    tickets: [{
      id: "tk_1", order_id: "ord_1", order_item_id: "oi_1", lot_id: "lot_1",
      event_id: "ev_1", status: "refund_pending", refund_request_id: REQ,
      participant_id: "part_1", is_deleted: false,
    }],
    participants: [{
      id: "part_1", registration_status: "confirmed", role_in_event: "attendee",
      created_date: "2026-01-01T10:00:00.000Z",
    }],
    salesLots: [lot],
  });
}

const runRefund = (db) => applyConfirmedStripeRefund(
  db.svc, db.payment("pay_1"), db.orders[0], db.refundRequests[0], 10000, 10000,
);

// ---------------------------------------------------------------------------
// 1. CAS aplica: decremento + registro na mesma escrita
// ---------------------------------------------------------------------------
test("1 — CAS aplica: sucesso, decremento único e registro do ingresso", async () => {
  const db = stockDb([{ id: "lot_1", quantity_sold: 3 }]);

  const res = await returnSoldQuantityOnce(db.svc, "lot_1", "tk_1");

  assert.equal(res.ok, true);
  assert.equal(res.applied, true, "devolução efetivada nesta chamada");
  assert.equal(db.salesLots[0].quantity_sold, 2, "exatamente um decremento");
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"], "registro gravado");
});

// ---------------------------------------------------------------------------
// 2. CAS zero porque o ingresso JÁ está registrado: repetição legítima
// ---------------------------------------------------------------------------
test("2 — CAS sem atualização porque o ingresso já está registrado: idempotente, sem novo decremento", async () => {
  const db = stockDb([{ id: "lot_1", quantity_sold: 2, stock_returned_ticket_ids: ["tk_1"] }]);

  const res = await returnSoldQuantityOnce(db.svc, "lot_1", "tk_1");

  assert.equal(res.ok, true, "devolução anterior comprovada pelo registro");
  assert.equal(res.applied, false, "nada foi decrementado agora");
  assert.equal(db.salesLots[0].quantity_sold, 2, "estoque intacto");
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"], "registro único");
});

// ---------------------------------------------------------------------------
// 3. CAS zero porque o lote não existe: falha explícita
// ---------------------------------------------------------------------------
test("3 — CAS sem atualização e lote inexistente: falha explícita", async () => {
  const db = stockDb([]);

  const res = await returnSoldQuantityOnce(db.svc, "lot_missing", "tk_1");

  assert.equal(res.ok, false, "ausência do lote não é devolução");
  assert.match(res.reason, /não encontrado/);
  assert.equal(db.salesLots.length, 0);
});

// ---------------------------------------------------------------------------
// 4. CAS zero e o ingresso NÃO está registrado: falha explícita
// ---------------------------------------------------------------------------
test("4 — CAS sem atualização e ingresso não registrado: falha explícita, sem segunda tentativa", async () => {
  const db = stockDb([{ id: "lot_1", quantity_sold: 5 }]);
  const zero = zeroWithoutError(db);

  const res = await returnSoldQuantityOnce(db.svc, "lot_1", "tk_1");

  assert.equal(res.ok, false, "ausência de atualização isolada não é prova");
  assert.match(res.reason, /não registrado/);
  assert.equal(zero.calls(), 1, "nenhuma segunda tentativa de decremento");
  assert.equal(db.salesLots[0].quantity_sold, 5, "estoque intacto");
  assert.equal(db.salesLots[0].stock_returned_ticket_ids, undefined, "nada registrado");
});

// ---------------------------------------------------------------------------
// 5. CAS zero e a leitura de confirmação falha: falha explícita
// ---------------------------------------------------------------------------
test("5 — CAS sem atualização e leitura de confirmação indisponível: falha explícita", async () => {
  const db = stockDb([{ id: "lot_1", quantity_sold: 5, stock_returned_ticket_ids: ["tk_1"] }]);
  const zero = zeroWithoutError(db);
  const restoreRead = breakRead(db);

  const res = await returnSoldQuantityOnce(db.svc, "lot_1", "tk_1");

  assert.equal(res.ok, false, "sem confirmação não há como declarar devolução");
  assert.match(res.reason, /Leitura de confirmação/);
  assert.equal(zero.calls(), 1, "sem segundo decremento");
  assert.equal(db.salesLots[0].quantity_sold, 5, "estoque intacto");

  restoreRead();
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"]);
});

// ---------------------------------------------------------------------------
// 6. Webhook duplicado continua sem duplicar estoque
// ---------------------------------------------------------------------------
test("6 — webhook duplicado: estoque devolvido uma única vez", async () => {
  const db = refundFixture();

  assert.equal((await runRefund(db)).ok, true);
  assert.equal((await runRefund(db)).ok, true);
  assert.equal((await runRefund(db)).ok, true);

  assert.equal(db.salesLots[0].quantity_sold, 0, "um único decremento");
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"], "um único registro");
  assert.equal(db.payment("pay_1").refunded_cents, 10000, "valor não reaplica");
  assert.equal(db.refundRequests[0].status, "processed");
});

// ---------------------------------------------------------------------------
// 7. Falha de estoque impede a conclusão de Payment, Order e RefundRequest
// ---------------------------------------------------------------------------
test("7 — CAS silenciosamente sem efeito NÃO conclui Payment, Order nem RefundRequest", async () => {
  const db = refundFixture();
  const zero = zeroWithoutError(db);

  const res = await runRefund(db);

  assert.equal(res.ok, false, "sucesso não é declarado sem devolução comprovada");
  assert.match(res.reason, /não registrado/);
  assert.equal(zero.calls(), 1, "sem segundo decremento");

  // Estoque: nada devolvido, nada registrado.
  assert.equal(db.salesLots[0].quantity_sold, 1);
  assert.equal(db.salesLots[0].stock_returned_ticket_ids, undefined);

  // Estados finais: nenhum registro financeiro/operacional concluído.
  assert.equal(db.payment("pay_1").status, "succeeded", "pagamento NÃO declarado estornado");
  assert.equal(db.orders[0].status, "paid", "pedido NÃO declarado estornado");
  assert.equal(db.refundRequests[0].status, "approved", "solicitação NÃO concluída");
  assert.equal(db.refundRequests[0].processed_at, undefined, "sem data de conclusão");
});

// ---------------------------------------------------------------------------
// 8. Retry após a recuperação da leitura converge sem duplicação
// ---------------------------------------------------------------------------
test("8 — retry após recuperação da leitura converge sem duplicar estoque", async () => {
  // Devolução JÁ registrada por execução anterior (estoque 0, ingresso no registro).
  const db = refundFixture({ quantitySold: 0, returned: ["tk_1"] });
  const restoreRead = breakRead(db);

  const first = await runRefund(db);
  assert.equal(first.ok, false, "sem leitura não há como provar a devolução anterior");
  assert.equal(db.payment("pay_1").status, "succeeded");
  assert.equal(db.orders[0].status, "paid");
  assert.equal(db.refundRequests[0].status, "approved");
  assert.equal(db.salesLots[0].quantity_sold, 0, "nenhum decremento adicional");
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"], "registro único");

  restoreRead();
  const retried = await runRefund(db);

  assert.equal(retried.ok, true, "leitura restabelecida confirma a devolução anterior");
  assert.equal(db.salesLots[0].quantity_sold, 0, "SEM segundo decremento");
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"], "registro único");
  assert.equal(db.payment("pay_1").status, "refunded");
  assert.equal(db.payment("pay_1").refunded_cents, 10000);
  assert.equal(db.orders[0].status, "refunded");
  assert.equal(db.refundRequests[0].status, "processed");
  assert.ok(db.refundRequests[0].processed_at);
  assert.equal(db.tickets[0].status, "refunded");
  assert.equal(db.tickets[0].refunded_by_request_id, REQ);
  assert.equal(db.participants[0].registration_status, "cancelled");
  assert.equal(db.orderItems[0].refunded, true);
});
// P1 (patch Fase 1, 2026-11-12) — RECUPERAÇÃO OPERACIONAL E CONCLUSÃO DA SOLICITAÇÃO.
//
// Exercita os MÓDULOS DE PRODUÇÃO:
//   base44/shared/commerceFulfillment.ts (processRefundSuccess,
//                                         applyConfirmedStripeRefund,
//                                         returnSoldQuantityOnce via os acima)
//   base44/shared/refundLedger.ts        (via as funções acima)
// contra o fakeDb (CAS por documento, mesma semântica do banco real).
//
// Prova: devolução de estoque exatamente uma vez mesmo com falha antes/depois do
// decremento, retry convergente sem duplicar efeitos e solicitação que só é
// declarada concluída com o estado persistido.
// NÃO prova: concorrência real de banco, atomicidade do documento no banco real
// (verificado à parte por sonda de sintaxe), Stripe ou rede.
//
// Execução: npm run test:unit:refund

import test from "node:test";
import assert from "node:assert/strict";

import { createFakeDb, basePayment } from "./lib/fakeDb.mjs";
import { applyConfirmedStripeRefund } from "../../base44/shared/commerceFulfillment.ts";

const REQ = "req_A";

function readyPayment(over = {}) {
  // Ledger normalizado com a reserva de REQ viva (comprometido = confirmado + reservado).
  return basePayment({
    refunded_cents: 0,
    refund_reserved_cents: 10000,
    refund_committed_cents: 10000,
    refund_reservation_ids: [REQ],
    refunded_amount: 0,
    ...over,
  });
}

function baseRequest(over = {}) {
  return {
    id: REQ,
    payment_id: "pay_1",
    order_id: "ord_1",
    event_id: "ev_1",
    status: "approved",
    refund_type: "full",
    amount_requested: 100,
    requested_by_user_id: "u1",
    stripe_refund_id: "re_1",
    is_deleted: false,
    ...over,
  };
}

function makeFixture({ payment, ticketStatus = "refund_pending", request } = {}) {
  return createFakeDb({
    payments: [payment || readyPayment()],
    refundRequests: [baseRequest(request)],
    orders: [
      { id: "ord_1", event_id: "ev_1", buyer_user_id: "u1", status: "paid", total: 100 },
    ],
    orderItems: [{ id: "oi_1", order_id: "ord_1", refunded: false, is_deleted: false }],
    tickets: [
      {
        id: "tk_1",
        order_id: "ord_1",
        order_item_id: "oi_1",
        lot_id: "lot_1",
        event_id: "ev_1",
        status: ticketStatus,
        refund_request_id: REQ,
        participant_id: "part_1",
        is_deleted: false,
      },
    ],
    participants: [
      {
        id: "part_1",
        registration_status: "confirmed",
        role_in_event: "attendee",
        created_date: "2026-01-01T10:00:00.000Z",
      },
    ],
    salesLots: [{ id: "lot_1", quantity_sold: 1 }],
  });
}

// Executa o caminho "webhook/reconciler com associação inequívoca".
function run(db, cumulative = 10000, charge = 10000) {
  return applyConfirmedStripeRefund(
    db.svc, db.payment("pay_1"), db.orders[0], db.refundRequests[0], cumulative, charge,
  );
}

// Falha uma etapa e devolve a função de restauração (recuperação do banco).
function breakStage(db, entity, method, message) {
  const real = db.svc.entities[entity][method].bind(db.svc.entities[entity]);
  db.svc.entities[entity][method] = async () => { throw new Error(message); };
  return () => { db.svc.entities[entity][method] = real; };
}

// Consistência FINAL entre todas as entidades (valores, não retorno de função).
function assertFinalConsistency(db, { partial = false, cents = 10000 } = {}) {
  const pay = db.payment("pay_1");
  assert.equal(pay.refunded_cents, cents, "confirmado aplicado uma vez");
  assert.equal(pay.refund_committed_cents, cents, "comprometido = confirmado (reserva consumida, sem dobrar)");
  assert.equal(pay.refund_reserved_cents, 0, "reserva consumida");
  assert.deepEqual(pay.refund_reservation_ids, [], "token da reserva removido");
  assert.equal(pay.status, partial ? "partially_refunded" : "refunded");

  assert.equal(db.orders[0].status, partial ? "partially_refunded" : "refunded");

  const req = db.refundRequests[0];
  assert.equal(req.status, "processed", "solicitação concluída e persistida");
  assert.ok(req.processed_at, "data de conclusão gravada");

  assert.equal(db.tickets[0].status, "refunded");
  assert.equal(db.tickets[0].refund_request_id, null, "trava consumida");
  assert.equal(db.tickets[0].refunded_by_request_id, REQ, "origem carimbada");
  assert.equal(db.participants[0].registration_status, "cancelled");
  assert.equal(db.orderItems[0].refunded, true);

  assert.equal(db.salesLots[0].quantity_sold, 0, "estoque devolvido");
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"], "devolução registrada uma única vez");
}

// ---------------------------------------------------------------------------
// 1. Estoque devolvido uma única vez
// ---------------------------------------------------------------------------
test("1 — estoque devolvido exatamente uma vez, com registro no lote", async () => {
  const db = makeFixture();
  const res = await run(db);

  assert.equal(res.ok, true);
  assert.equal(db.salesLots[0].quantity_sold, 0);
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"]);
  assertFinalConsistency(db);
});

// ---------------------------------------------------------------------------
// 2. Falha no estoque e retry bem-sucedido
// ---------------------------------------------------------------------------
test("2 — falha na devolução de estoque: nada é declarado concluído e o retry conclui", async () => {
  const db = makeFixture();
  const restore = breakStage(db, "SalesLot", "updateMany", "estoque indisponível");

  const first = await run(db);
  assert.equal(first.ok, false, "falha operacional não é sucesso");
  assert.match(first.reason, /estoque indisponível/);
  assert.equal(db.payment("pay_1").status, "succeeded", "pagamento não declarado estornado");
  assert.equal(db.orders[0].status, "paid", "pedido não declarado estornado");
  assert.equal(db.refundRequests[0].status, "approved", "solicitação não concluída");
  assert.equal(db.tickets[0].status, "refunded", "efeitos anteriores preservados");
  assert.equal(db.salesLots[0].quantity_sold, 1, "devolução pendente (recuperável)");

  restore();
  const retried = await run(db);
  assert.equal(retried.ok, true);
  assert.equal(db.salesLots[0].quantity_sold, 0, "estoque devolvido no retry");
  assertFinalConsistency(db);
});

// ---------------------------------------------------------------------------
// 3. Falha DEPOIS do decremento, antes da confirmação operacional
// ---------------------------------------------------------------------------
test("3 — falha após o decremento: retry não devolve o estoque de novo", async () => {
  const db = makeFixture();
  const restore = breakStage(db, "Payment", "update", "status do pagamento indisponível");

  const first = await run(db);
  assert.equal(first.ok, false);
  // O decremento JÁ aconteceu e está registrado no lote — o retry não pode repetir.
  assert.equal(db.salesLots[0].quantity_sold, 0);
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"]);
  assert.equal(db.refundRequests[0].status, "approved", "solicitação ainda não concluída");

  restore();
  const retried = await run(db);
  assert.equal(retried.ok, true);
  assert.equal(db.salesLots[0].quantity_sold, 0, "SEM segundo decremento");
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"], "registro único");
  assertFinalConsistency(db);
});

// ---------------------------------------------------------------------------
// 4. Retry repetido: nenhuma duplicação
// ---------------------------------------------------------------------------
test("4 — repetições sucessivas: nenhum efeito duplicado", async () => {
  const db = makeFixture();
  assert.equal((await run(db)).ok, true);
  const processedAt = db.refundRequests[0].processed_at;

  assert.equal((await run(db)).ok, true);
  assert.equal((await run(db)).ok, true);

  assert.equal(db.salesLots[0].quantity_sold, 0);
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"]);
  assert.equal(db.refundRequests[0].processed_at, processedAt, "solicitação não é reprocessada");
  assertFinalConsistency(db);
});

// ---------------------------------------------------------------------------
// 5. Falha na persistência da RefundRequest
// ---------------------------------------------------------------------------
test("5 — falha ao persistir a solicitação: não é declarada concluída", async () => {
  const db = makeFixture();
  const restore = breakStage(db, "RefundRequest", "updateMany", "escrita da solicitação indisponível");

  const first = await run(db);
  assert.equal(first.ok, false, "persistência pendente não é sucesso");
  assert.match(first.reason, /não persistido/i);
  assert.equal(db.refundRequests[0].status, "approved");
  assert.equal(db.refundRequests[0].processed_at, undefined);

  restore();
  const retried = await run(db);
  assert.equal(retried.ok, true);
  assert.ok(db.refundRequests[0].processed_at);
  assert.equal(db.salesLots[0].quantity_sold, 0, "estoque não foi devolvido duas vezes");
  assertFinalConsistency(db);
});

// ---------------------------------------------------------------------------
// 6. Retry após recuperação da escrita: converge uma única vez
// ---------------------------------------------------------------------------
test("6 — retry após recuperação da escrita conclui exatamente o que faltava", async () => {
  const db = makeFixture();
  const restorePayment = breakStage(db, "Payment", "update", "pagamento indisponível");
  const restoreRequest = breakStage(db, "RefundRequest", "updateMany", "solicitação indisponível");

  assert.equal((await run(db)).ok, false);
  const midStock = db.salesLots[0].quantity_sold;
  assert.equal(midStock, 0, "devolução já efetivada antes das falhas");

  restorePayment();
  assert.equal((await run(db)).ok, false, "persistência da solicitação ainda indisponível");

  restoreRequest();
  assert.equal((await run(db)).ok, true);
  assert.equal(db.salesLots[0].quantity_sold, 0);
  assertFinalConsistency(db);
});

// ---------------------------------------------------------------------------
// 7. Solicitação 'failed' (ingresso utilizado) nunca vira 'processed'
// ---------------------------------------------------------------------------
test("7 — solicitação marcada como failed por ingresso utilizado não é reclassificada", async () => {
  const db = makeFixture({ ticketStatus: "used" });

  const first = await run(db);
  assert.equal(first.ok, true, "estorno confirmado no Stripe é processado");
  assert.equal(first.usedSkipped, 1);
  assert.equal(db.refundRequests[0].status, "failed");
  assert.equal(db.tickets[0].status, "used", "ingresso utilizado permanece válido");
  assert.equal(db.salesLots[0].quantity_sold, 1, "nenhum estoque devolvido");
  assert.equal(db.salesLots[0].stock_returned_ticket_ids, undefined);

  const second = await run(db);
  assert.equal(second.ok, true, "repetição idempotente");
  assert.equal(db.refundRequests[0].status, "failed");

  // Check-in revertido: o ingresso volta a ser elegível, mas a solicitação já
  // marcada como falha NÃO pode ser promovida a 'processed' por estado antigo.
  db.tickets[0].status = "refund_pending";
  db.tickets[0].refund_request_id = REQ;
  const third = await run(db);
  assert.equal(third.ok, false, "conclusão não é declarada sem persistir o estado");
  assert.equal(db.refundRequests[0].status, "failed", "estado persistido preservado");
  assert.equal(db.refundRequests[0].processed_at, undefined);
});

// ---------------------------------------------------------------------------
// 8. Webhook duplicado: nenhum valor, reserva ou estoque reconta
// ---------------------------------------------------------------------------
test("8 — webhook duplicado não reaplica valor, reserva nem estoque", async () => {
  const db = makeFixture();
  assert.equal((await run(db)).ok, true);
  const processedAt = db.refundRequests[0].processed_at;

  assert.equal((await run(db)).ok, true);
  assert.equal((await run(db)).ok, true);

  const pay = db.payment("pay_1");
  assert.equal(pay.refunded_cents, 10000);
  assert.equal(pay.refund_committed_cents, 10000);
  assert.equal(pay.refund_reserved_cents, 0);
  assert.deepEqual(pay.refund_reservation_ids, []);
  assert.equal(db.refundRequests[0].processed_at, processedAt);
  assert.equal(db.salesLots[0].quantity_sold, 0);
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"]);
});

// ---------------------------------------------------------------------------
// 9. Falha intermediária em CADA etapa operacional
// ---------------------------------------------------------------------------
test("9 — falha em cada etapa: explícita, recuperável e sem duplicação", async () => {
  const stages = [
    ["Ticket", "update"],
    ["Participant", "update"],
    ["OrderItem", "update"],
    ["SalesLot", "updateMany"],
    ["Payment", "update"],
    ["Order", "update"],
    ["RefundRequest", "updateMany"],
  ];

  for (const [entity, method] of stages) {
    const label = `${entity}.${method}`;
    const db = makeFixture();
    const restore = breakStage(db, entity, method, `falha em ${label}`);

    const failed = await run(db);
    assert.equal(failed.ok, false, `${label}: falha precisa ser explícita`);
    assert.equal(db.refundRequests[0].status !== "processed", true, `${label}: solicitação não concluída`);

    restore();
    const retried = await run(db);
    assert.equal(retried.ok, true, `${label}: retry conclui`);
    assert.equal(db.salesLots[0].quantity_sold, 0, `${label}: estoque devolvido uma única vez`);
    assertFinalConsistency(db);
  }
});

// ---------------------------------------------------------------------------
// 10. Consistência final — integral e parcial
// ---------------------------------------------------------------------------
test("10 — consistência final entre Payment, RefundRequest, Ticket, Participant, OrderItem e SalesLot", async () => {
  const full = makeFixture();
  assert.equal((await run(full)).ok, true);
  assertFinalConsistency(full, { partial: false });

  const partial = makeFixture({ payment: readyPayment({ amount_cents: 10000 }) });
  const partialRes = await run(partial, 4000, 10000);
  assert.equal(partialRes.ok, true);
  assert.equal(partialRes.isPartial, true);
  assert.equal(partial.payment("pay_1").refunded_cents, 4000, "parcial confirmado pelo valor do Stripe");
  assertFinalConsistency(partial, { partial: true, cents: 4000 });
  assert.equal(partial.refundRequests[0].amount_refunded, 100, "valor registrado na solicitação");
});

// ---------------------------------------------------------------------------
// 11. Duas solicitações distintas no MESMO pagamento
// ---------------------------------------------------------------------------
test("11 — duas solicitações no mesmo pagamento: estoque devolvido uma vez por ingresso", async () => {
  const db = createFakeDb({
    payments: [
      basePayment({
        amount: 100, amount_cents: 10000, refunded_cents: 0,
        refund_reserved_cents: 5000, refund_committed_cents: 5000,
        refund_reservation_ids: [REQ], refunded_amount: 0,
      }),
    ],
    refundRequests: [
      baseRequest({ refund_type: "cancel_item", order_item_ids: ["oi_1"], amount_requested: 50 }),
    ],
    orders: [{ id: "ord_1", event_id: "ev_1", buyer_user_id: "u1", status: "paid", total: 100 }],
    orderItems: [
      { id: "oi_1", order_id: "ord_1", refunded: false, is_deleted: false },
      { id: "oi_2", order_id: "ord_1", refunded: false, is_deleted: false },
    ],
    tickets: [
      {
        id: "tk_1", order_id: "ord_1", order_item_id: "oi_1", lot_id: "lot_1", event_id: "ev_1",
        status: "refund_pending", refund_request_id: REQ, participant_id: "part_1", is_deleted: false,
      },
      {
        id: "tk_2", order_id: "ord_1", order_item_id: "oi_2", lot_id: "lot_1", event_id: "ev_1",
        status: "issued", participant_id: "part_2", is_deleted: false,
      },
    ],
    participants: [
      { id: "part_1", registration_status: "confirmed", role_in_event: "attendee", created_date: "2026-01-01T10:00:00.000Z" },
      { id: "part_2", registration_status: "confirmed", role_in_event: "attendee", created_date: "2026-01-01T10:00:00.000Z" },
    ],
    salesLots: [{ id: "lot_1", quantity_sold: 2 }],
  });

  const first = await applyConfirmedStripeRefund(
    db.svc, db.payment("pay_1"), db.orders[0], db.refundRequests[0], 5000, 10000,
  );
  assert.equal(first.ok, true);
  assert.equal(db.salesLots[0].quantity_sold, 1, "uma unidade devolvida");
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1"]);

  // Segunda solicitação, outro item do MESMO pagamento, com sua própria reserva.
  db.refundRequests.push(baseRequest({
    id: "req_B", refund_type: "cancel_item", order_item_ids: ["oi_2"], amount_requested: 50,
  }));
  db.tickets[1].status = "refund_pending";
  db.tickets[1].refund_request_id = "req_B";
  Object.assign(db.payment("pay_1"), {
    refund_reserved_cents: 5000, refund_committed_cents: 10000, refund_reservation_ids: ["req_B"],
  });

  const second = await applyConfirmedStripeRefund(
    db.svc, db.payment("pay_1"), db.orders[0], db.refundRequests[1], 10000, 10000,
  );
  assert.equal(second.ok, true);
  assert.equal(db.salesLots[0].quantity_sold, 0, "segunda unidade devolvida");
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1", "tk_2"]);

  // Repetição de AMBAS (webhooks duplicados): nada é devolvido de novo.
  const replayA = await applyConfirmedStripeRefund(
    db.svc, db.payment("pay_1"), db.orders[0], db.refundRequests[0], 5000, 10000,
  );
  const replayB = await applyConfirmedStripeRefund(
    db.svc, db.payment("pay_1"), db.orders[0], db.refundRequests[1], 10000, 10000,
  );
  assert.equal(replayA.ok, true);
  assert.equal(replayB.ok, true);
  assert.equal(db.salesLots[0].quantity_sold, 0, "SEM terceira devolução");
  assert.deepEqual(db.salesLots[0].stock_returned_ticket_ids, ["tk_1", "tk_2"]);
  assert.equal(db.refundRequests[0].status, "processed");
  assert.equal(db.refundRequests[1].status, "processed");
  assert.equal(db.tickets[0].refunded_by_request_id, REQ);
  assert.equal(db.tickets[1].refunded_by_request_id, "req_B");
});
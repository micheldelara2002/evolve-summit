// P0.1 (patch final Fase 1) — FALHA DO LEDGER NÃO CONCLUI O ESTORNO.
//
// Exercita os MÓDULOS DE PRODUÇÃO:
//   base44/shared/commerceFulfillment.ts  (processRefundSuccess,
//                                          applyConfirmedStripeRefund,
//                                          applyUnassociatedRefundAmount)
//   base44/shared/refundLedger.ts         (via as funções acima)
// contra o fakeDb, com a mesma semântica de CAS do banco real.
//
// O que estes testes provam: nenhuma falha de ledger resulta em solicitação,
// pagamento ou pedido declarado concluído localmente.
// O que estes testes NÃO provam: concorrência real de banco, integração real com
// o Stripe ou comportamento de rede.
//
// Execução: npm run test:unit:refund

import test from "node:test";
import assert from "node:assert/strict";

import { createFakeDb, basePayment } from "./lib/fakeDb.mjs";
import {
  applyConfirmedStripeRefund,
  applyUnassociatedRefundAmount,
} from "../../base44/shared/commerceFulfillment.ts";

const REQ_A = "req_A";

function readyPayment(over = {}) {
  // Ledger já normalizado com a reserva de req_A viva (invariante:
  // comprometido = confirmado + reservado).
  return basePayment({
    refunded_cents: 0,
    refund_reserved_cents: 10000,
    refund_committed_cents: 10000,
    refund_reservation_ids: [REQ_A],
    refunded_amount: 0,
    ...over,
  });
}

// Pagamento legado: sem os contadores do ledger — a normalização é o primeiro
// passo e é justamente onde injetamos a falha.
function legacyPayment(over = {}) {
  return basePayment({ refunded_amount: 0, ...over });
}

function baseRequest(over = {}) {
  return {
    id: REQ_A,
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

function makeFixture({ payment, refundRequests } = {}) {
  return createFakeDb({
    payments: [payment || readyPayment()],
    refundRequests: refundRequests || [baseRequest()],
    orders: [
      {
        id: "ord_1",
        event_id: "ev_1",
        buyer_user_id: "u1",
        buyer_email: "buyer@example.com",
        status: "paid",
        total: 100,
      },
    ],
    orderItems: [{ id: "oi_1", order_id: "ord_1", refunded: false, is_deleted: false }],
    tickets: [
      {
        id: "tk_1",
        order_id: "ord_1",
        order_item_id: "oi_1",
        lot_id: "lot_1",
        event_id: "ev_1",
        status: "refund_pending",
        refund_request_id: REQ_A,
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

// Roda o caminho "webhook/reconciler com associação inequívoca".
function runMatched(db, cumulative = 10000, charge = 10000) {
  return applyConfirmedStripeRefund(
    db.svc, db.payment("pay_1"), db.orders[0], db.refundRequests[0], cumulative, charge,
  );
}

// Estado operacional intacto (nada cancelado).
function assertNothingTouched(db) {
  assert.equal(db.tickets[0].status, "refund_pending", "ingresso intacto");
  assert.equal(db.tickets[0].refund_request_id, REQ_A, "trava de estorno preservada");
  assert.equal(db.participants[0].registration_status, "confirmed", "participante intacto");
  assert.equal(db.orderItems[0].refunded, false, "item não marcado como estornado");
  assert.equal(db.salesLots[0].quantity_sold, 1, "estoque não devolvido");
}

// ---------------------------------------------------------------------------
// 1. Ledger normalizado e atualização bem-sucedida: fluxo normal concluído
// ---------------------------------------------------------------------------

test("1 — ledger saudável: conclusão local completa (pagamento, pedido, solicitação, ingresso)", async () => {
  const db = makeFixture();
  const res = await runMatched(db);

  assert.equal(res.ok, true);
  assert.equal(res.isPartial, false);
  assert.equal(res.refundAmountBRL, 100);

  const pay = db.payment("pay_1");
  assert.equal(pay.status, "refunded");
  assert.equal(pay.refunded_cents, 10000, "confirmado aplicado");
  assert.equal(pay.refunded_amount, 100);
  assert.equal(pay.refund_reserved_cents, 0, "reserva consumida");
  assert.equal(pay.refund_committed_cents, 10000, "teto mantido (não dobrou)");
  assert.deepEqual(pay.refund_reservation_ids, [], "token da reserva removido");

  assert.equal(db.orders[0].status, "refunded");
  assert.equal(db.refundRequests[0].status, "processed");
  assert.ok(db.refundRequests[0].processed_at, "data de processamento gravada");
  assert.equal(db.refundRequests[0].amount_refunded, 100);

  assert.equal(db.tickets[0].status, "refunded");
  assert.equal(db.tickets[0].refund_request_id, null, "trava consumida");
  assert.equal(db.participants[0].registration_status, "cancelled");
  assert.equal(db.orderItems[0].refunded, true);
  assert.equal(db.salesLots[0].quantity_sold, 0);
});

// ---------------------------------------------------------------------------
// 2. Falha na normalização: nenhuma conclusão local indevida
// ---------------------------------------------------------------------------

test("2 — falha na normalização: nada é concluído e nenhum efeito operacional ocorre", async () => {
  const db = makeFixture({ payment: legacyPayment() });
  db.svc.entities.Payment.updateMany = async () => { throw new Error("escrita indisponível"); };

  const res = await runMatched(db);

  assert.equal(res.ok, false, "sem ledger não há sucesso");
  assert.match(res.reason, /ledger/i);

  const pay = db.payment("pay_1");
  assert.equal(pay.status, "succeeded", "pagamento NÃO é declarado estornado");
  assert.equal(pay.refunded_cents, undefined, "contador confirmado não foi inventado");
  assert.equal(pay.refund_committed_cents, undefined);
  assert.equal(db.orders[0].status, "paid", "pedido NÃO é declarado estornado");
  assert.equal(db.refundRequests[0].status, "approved", "solicitação NÃO vira processed");
  assert.equal(db.refundRequests[0].processed_at, undefined);
  assertNothingTouched(db);
  assert.equal(db.auditLogs.length, 0, "nenhuma trilha de sucesso emitida");
});

// ---------------------------------------------------------------------------
// 3. Falha na atualização do contador confirmado: Payment não é estornado
// ---------------------------------------------------------------------------

test("3 — CAS do valor confirmado falha: Payment/Order/solicitação/ingressos permanecem", async () => {
  const db = makeFixture();
  const original = db.svc.entities.Payment.updateMany.bind(db.svc.entities.Payment);
  // Aceita escritas de reserva, recusa TODA escrita que move o valor confirmado.
  db.svc.entities.Payment.updateMany = async (query, update) =>
    (update?.$set && "refunded_cents" in update.$set ? { updated: 0 } : original(query, update));

  const res = await runMatched(db);

  assert.equal(res.ok, false);
  const pay = db.payment("pay_1");
  assert.equal(pay.refunded_cents, 0, "confirmado NÃO avançou");
  assert.equal(pay.refund_committed_cents, 10000, "teto intacto");
  assert.equal(pay.refund_reserved_cents, 10000, "reserva ainda viva");
  assert.deepEqual(pay.refund_reservation_ids, [REQ_A], "token preservado para retry");
  assert.equal(pay.status, "succeeded");
  assert.equal(db.orders[0].status, "paid");
  assert.equal(db.refundRequests[0].status, "approved");
  assertNothingTouched(db);
});

// ---------------------------------------------------------------------------
// 4. Falha no ledger com RefundRequest associada: não vira 'processed'
// ---------------------------------------------------------------------------

test("4 — solicitação associada não é marcada como processed quando o ledger falha", async () => {
  const db = makeFixture({ payment: legacyPayment() });
  db.svc.entities.Payment.updateMany = async () => { throw new Error("indisponível"); };

  await runMatched(db);

  const req = db.refundRequests[0];
  assert.equal(req.status, "approved", "status original mantido");
  assert.equal(req.processed_at, undefined);
  assert.equal(req.amount_refunded, undefined, "nada é declarado devolvido localmente");
  assert.equal(req.stripe_refund_id, "re_1", "vínculo de identidade preservado");
});

// ---------------------------------------------------------------------------
// 5. Falha sem associação: confirmação rastreável, status local não concluído
// ---------------------------------------------------------------------------

test("5a — sem associação e ledger saudável: só o lado financeiro é reconciliado", async () => {
  const db = makeFixture({
    payment: basePayment({
      refunded_cents: 0, refund_reserved_cents: 0, refund_committed_cents: 0, refund_reservation_ids: [],
    }),
  });

  const res = await applyUnassociatedRefundAmount(db.svc, db.payment("pay_1"), 4000, 10000);

  assert.equal(res.ok, true);
  assert.equal(res.applied, true);
  assert.equal(res.isPartial, true);
  assert.equal(db.payment("pay_1").status, "partially_refunded");
  assert.equal(db.payment("pay_1").refunded_cents, 4000);
  // Nenhum efeito operacional: o estorno não foi associado a uma solicitação.
  assertNothingTouched(db);
});

test("5b — sem associação e ledger indisponível: Payment NÃO é declarado estornado", async () => {
  const db = makeFixture({
    payment: legacyPayment(),
  });
  db.svc.entities.Payment.updateMany = async () => { throw new Error("indisponível"); };

  const res = await applyUnassociatedRefundAmount(db.svc, db.payment("pay_1"), 4000, 10000);

  assert.equal(res.ok, false);
  assert.equal(res.applied, false);
  assert.match(res.reason, /ledger/i);
  assert.equal(db.payment("pay_1").status, "succeeded", "status local não concluído");
  assert.equal(db.payment("pay_1").refunded_cents, undefined);
  assertNothingTouched(db);
});

test("5c — falha ao gravar o status do pagamento também não é sucesso silencioso", async () => {
  const db = makeFixture({
    payment: basePayment({
      refunded_cents: 0, refund_reserved_cents: 0, refund_committed_cents: 0, refund_reservation_ids: [],
    }),
  });
  db.svc.entities.Payment.update = async () => { throw new Error("status indisponível"); };

  const res = await applyUnassociatedRefundAmount(db.svc, db.payment("pay_1"), 4000, 10000);

  assert.equal(res.ok, false);
  assert.match(res.reason, /status/i);
  assert.equal(db.payment("pay_1").refunded_cents, 4000, "valor confirmado já aplicado no ledger");
  assert.equal(db.payment("pay_1").status, "succeeded", "status local continua pendente");
});

// ---------------------------------------------------------------------------
// 6. Retry após recuperação do ledger: converge para o estado correto
// ---------------------------------------------------------------------------

test("6 — retry após o ledger voltar converge, sem contar o valor duas vezes", async () => {
  const db = makeFixture({ payment: legacyPayment() });
  const realUpdateMany = db.svc.entities.Payment.updateMany.bind(db.svc.entities.Payment);
  db.svc.entities.Payment.updateMany = async () => { throw new Error("indisponível"); };

  const failed = await runMatched(db);
  assert.equal(failed.ok, false);

  // Ledger volta (ferramenta/DB recuperado).
  db.svc.entities.Payment.updateMany = realUpdateMany;

  const retried = await runMatched(db);
  assert.equal(retried.ok, true);

  const pay = db.payment("pay_1");
  assert.equal(pay.refunded_cents, 10000, "confirmado aplicado UMA vez (cumulativo)");
  assert.equal(pay.refund_committed_cents, 10000);
  assert.equal(pay.refund_reserved_cents, 0);
  assert.equal(pay.status, "refunded");
  assert.equal(db.orders[0].status, "refunded");
  assert.equal(db.refundRequests[0].status, "processed");
  assert.equal(db.tickets[0].status, "refunded");
  assert.equal(db.salesLots[0].quantity_sold, 0);
});

// ---------------------------------------------------------------------------
// 7. Repetição do mesmo webhook: nenhum valor contabilizado duas vezes
// ---------------------------------------------------------------------------

test("7 — repetição do evento: valor, reserva e estoque não duplicam", async () => {
  const db = makeFixture();

  const first = await runMatched(db);
  assert.equal(first.ok, true);
  const processedAt = db.refundRequests[0].processed_at;
  assert.ok(processedAt);

  const second = await runMatched(db);
  assert.equal(second.ok, true, "repetição é aceita como no-op, não como erro");

  const pay = db.payment("pay_1");
  assert.equal(pay.refunded_cents, 10000, "confirmado não dobrou");
  assert.equal(pay.refund_committed_cents, 10000, "teto não dobrou");
  assert.equal(pay.refund_reserved_cents, 0);
  assert.deepEqual(pay.refund_reservation_ids, [], "reserva não voltou");
  assert.equal(db.salesLots[0].quantity_sold, 0, "estoque devolvido uma única vez");
  assert.equal(db.refundRequests[0].processed_at, processedAt, "solicitação não é reprocessada");
  assert.equal(db.refundRequests[0].amount_refunded, 100);
});

// ---------------------------------------------------------------------------
// 8. Falha intermediária após atualização do ledger: retry não duplica efeitos
// ---------------------------------------------------------------------------

test("8 — falha no ingresso depois do ledger: financeiro correto, retry conclui sem duplicar", async () => {
  const db = makeFixture();
  const realTicketUpdate = db.svc.entities.Ticket.update.bind(db.svc.entities.Ticket);
  let failures = 1;
  db.svc.entities.Ticket.update = async (id, patch) => {
    if (failures > 0) { failures--; throw new Error("falha transitória no ingresso"); }
    return realTicketUpdate(id, patch);
  };

  await assert.rejects(() => runMatched(db), /transitória/);

  // O ledger é o portão e já confirmou (o dinheiro voltou no Stripe): o valor
  // confirmado NÃO regride. O estado operacional ainda não foi concluído.
  assert.equal(db.payment("pay_1").refunded_cents, 10000);
  assert.equal(db.payment("pay_1").refund_committed_cents, 10000);
  assert.equal(db.payment("pay_1").status, "succeeded", "pagamento não é declarado estornado");
  assert.equal(db.tickets[0].status, "refund_pending", "ingresso não foi tocado");
  assert.equal(db.refundRequests[0].status, "approved", "solicitação segue pendente");

  const retried = await runMatched(db);
  assert.equal(retried.ok, true);
  assert.equal(db.payment("pay_1").refunded_cents, 10000, "confirmado não dobrou");
  assert.equal(db.payment("pay_1").refund_committed_cents, 10000, "teto não dobrou");
  assert.equal(db.payment("pay_1").refund_reserved_cents, 0);
  assert.equal(db.tickets[0].status, "refunded");
  assert.equal(db.salesLots[0].quantity_sold, 0, "estoque devolvido uma única vez");
  assert.equal(db.refundRequests[0].status, "processed");
});

// ---------------------------------------------------------------------------
// 9. Falha no processamento de ingressos: estados recuperáveis
// ---------------------------------------------------------------------------

test("9 — falha no estoque: financeiro consolidado, financeiro nunca é revertido nem duplicado", async () => {
  const db = makeFixture();
  const realLotUpdate = db.svc.entities.SalesLot.updateMany.bind(db.svc.entities.SalesLot);
  db.svc.entities.SalesLot.updateMany = async () => { throw new Error("estoque indisponível"); };

  await assert.rejects(() => runMatched(db), /estoque indisponível/);

  // Financeiro é autoritativo e já está consolidado; nada é revertido.
  assert.equal(db.payment("pay_1").refunded_cents, 10000);
  assert.equal(db.payment("pay_1").refund_committed_cents, 10000);
  assert.equal(db.payment("pay_1").status, "succeeded", "conclusão local não foi declarada");
  assert.equal(db.refundRequests[0].status, "approved");
  // Efeitos já aplicados neste ingresso (claim do ingresso é a ÚNICA escrita que
  // autoriza os efeitos seguintes — por isso o estoque nunca é decrementado 2x).
  assert.equal(db.tickets[0].status, "refunded");
  assert.equal(db.salesLots[0].quantity_sold, 1, "LIMITAÇÃO: devolução de estoque pendente de revisão manual");

  // Retry: converge no financeiro e no status, sem decremento duplicado.
  db.svc.entities.SalesLot.updateMany = realLotUpdate;
  const retried = await runMatched(db);
  assert.equal(retried.ok, true);
  assert.equal(db.payment("pay_1").refunded_cents, 10000, "não duplicou");
  assert.equal(db.salesLots[0].quantity_sold, 1, "sem decremento duplicado (ingresso já terminal)");
  assert.equal(db.payment("pay_1").status, "refunded");
  assert.equal(db.refundRequests[0].status, "processed");
});

// ---------------------------------------------------------------------------
// 10. Nenhuma falha silenciosa é convertida em sucesso
// ---------------------------------------------------------------------------

test("10 — matriz de falhas: nenhuma é reportada como sucesso", async () => {
  const scenarios = [
    {
      name: "normalização indisponível",
      prepare: (db) => {
        db.svc.entities.Payment.updateMany = async () => { throw new Error("indisponível"); };
      },
      payment: legacyPayment(),
    },
    {
      name: "CAS do confirmado falha",
      prepare: (db) => {
        const original = db.svc.entities.Payment.updateMany.bind(db.svc.entities.Payment);
        db.svc.entities.Payment.updateMany = async (query, update) =>
          (update?.$set && "refunded_cents" in update.$set ? { updated: 0 } : original(query, update));
      },
      payment: readyPayment(),
    },
    {
      name: "ingresso falha",
      prepare: (db) => {
        db.svc.entities.Ticket.update = async () => { throw new Error("ingresso indisponível"); };
      },
      payment: readyPayment(),
    },
  ];

  for (const scenario of scenarios) {
    const db = makeFixture({ payment: scenario.payment });
    scenario.prepare(db);
    let result = null;
    let threw = false;
    try {
      result = await runMatched(db);
    } catch {
      threw = true;
    }
    const concluded = result?.ok === true;
    assert.equal(concluded, false, `${scenario.name}: não pode ser sucesso`);
    assert.equal(db.refundRequests[0].status === "processed", false, `${scenario.name}: solicitação não concluída`);
    assert.equal(db.orders[0].status === "refunded", false, `${scenario.name}: pedido não concluído`);
    assert.equal(db.payment("pay_1").status === "refunded", false, `${scenario.name}: pagamento não concluído`);
    // Ou retorna ok=false de forma explícita, ou propaga o erro — nunca sucesso.
    assert.ok(threw || result?.ok === false, `${scenario.name}: falha precisa ser explícita`);
  }
});
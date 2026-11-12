// P0 (2026-11-12) — Testes das guardas do fluxo de estorno.
//
// Exercita as MESMAS funções puras usadas por requestRefund, pelo reconciliador
// (expireStaleReservations) e pela recuperação administrativa de travas legadas.
// Nenhum banco, nenhuma chamada ao Stripe: são as decisões de autorização,
// propriedade de trava, relações e valor que protegem o dinheiro.
//
// Execução: npm run test:unit:refund

import test from "node:test";
import assert from "node:assert/strict";

import {
  REFUND_REQUEST_PROVENANCE,
  classifyTicketLock,
  evaluateLockOwnership,
  isTrustedRefundRequest,
  resolveRefundAmountCents,
  validateRefundRelations,
} from "../../base44/shared/refundGuards.ts";

const REQ_A = "req_A";
const REQ_B = "req_B";

const ticket = (over = {}) => ({ id: "tk_1", status: "issued", refund_request_id: null, ...over });

// ---------- A. Autorização / origem confiável ----------

test("P0.1 — solicitação gravada pelo fluxo oficial é confiável", () => {
  assert.equal(isTrustedRefundRequest({ provenance: REFUND_REQUEST_PROVENANCE, idempotency_key: "k1" }), true);
});

test("P0.1 — solicitação forjada pelo SDK (sem provenance) é recusada", () => {
  assert.equal(isTrustedRefundRequest({ idempotency_key: "k1" }), false);
  assert.equal(isTrustedRefundRequest({ provenance: "outra", idempotency_key: "k1" }), false);
});

test("P0.1 — solicitação confiável sem chave de idempotência é recusada (nunca dispara Stripe)", () => {
  assert.equal(isTrustedRefundRequest({ provenance: REFUND_REQUEST_PROVENANCE, idempotency_key: "" }), false);
  assert.equal(isTrustedRefundRequest(null), false);
});

test("P0.1 — pagamento de outro pedido é recusado", () => {
  const payment = { id: "pay_1", order_id: "ord_2", event_id: "ev_1" };
  const order = { id: "ord_1", event_id: "ev_1" };
  const req = { id: REQ_A, order_id: "ord_1", payment_id: "pay_1", event_id: "ev_1" };
  assert.equal(validateRefundRelations(payment, order, req).ok, false);
});

test("P0.1 — pagamento de outro evento é recusado", () => {
  const payment = { id: "pay_1", order_id: "ord_1", event_id: "ev_2" };
  const order = { id: "ord_1", event_id: "ev_1" };
  const req = { id: REQ_A, order_id: "ord_1", payment_id: "pay_1", event_id: "ev_1" };
  assert.equal(validateRefundRelations(payment, order, req).ok, false);
});

test("P0.1 — solicitação apontando para outro pagamento é recusada", () => {
  const payment = { id: "pay_1", order_id: "ord_1", event_id: "ev_1" };
  const order = { id: "ord_1", event_id: "ev_1" };
  const req = { id: REQ_A, order_id: "ord_1", payment_id: "pay_9", event_id: "ev_1" };
  assert.equal(validateRefundRelations(payment, order, req).ok, false);
});

test("P0.1 — relações consistentes são aceitas", () => {
  const payment = { id: "pay_1", order_id: "ord_1", event_id: "ev_1" };
  const order = { id: "ord_1", event_id: "ev_1" };
  const req = { id: REQ_A, order_id: "ord_1", payment_id: "pay_1", event_id: "ev_1" };
  assert.equal(validateRefundRelations(payment, order, req).ok, true);
});

// ---------- B. Propriedade da trava (P0.2) ----------

test("P0.2 — ingresso livre (issued sem dono) é reivindicável", () => {
  assert.deepEqual(evaluateLockOwnership([ticket()], REQ_A), {
    ok: true, claimable: ["tk_1"], owned: 0, blocked: 0, terminal: 0, reason: "",
  });
});

test("P0.2 — ingresso já travado pela MESMA solicitação é reconhecido como próprio", () => {
  const res = evaluateLockOwnership([ticket({ status: "refund_pending", refund_request_id: REQ_A })], REQ_A);
  assert.equal(res.ok, true);
  assert.equal(res.owned, 1);
  assert.deepEqual(res.claimable, []);
});

test("P0.2 — solicitação A NÃO pode liberar/usar a trava da solicitação B", () => {
  const res = evaluateLockOwnership([ticket({ status: "refund_pending", refund_request_id: REQ_B })], REQ_A);
  assert.equal(res.ok, false);
  assert.equal(res.blocked, 1);
  assert.equal(classifyTicketLock(ticket({ status: "refund_pending", refund_request_id: REQ_B }), REQ_A), "blocked");
});

test("P0.2 — ingresso legado travado SEM refund_request_id exige recuperação administrativa", () => {
  const legacy = ticket({ status: "refund_pending", refund_request_id: null });
  assert.equal(classifyTicketLock(legacy, REQ_A), "blocked");
  assert.equal(classifyTicketLock(legacy, undefined), "blocked");
  assert.equal(evaluateLockOwnership([legacy], REQ_A).ok, false);
});

test("P0.2 — operação sem refund_request_id não reivindica nem libera nada", () => {
  const res = evaluateLockOwnership([ticket(), ticket({ id: "tk_2", status: "refund_pending" })], undefined);
  assert.equal(res.ok, false);
  assert.deepEqual(res.claimable, []);
  assert.equal(classifyTicketLock(ticket(), undefined), "claimable"); // estado lido, mas sem dono → nunca age
});

test("P0.2 — ingresso utilizado bloqueia o estorno (dinheiro não volta)", () => {
  assert.equal(classifyTicketLock(ticket({ status: "used" }), REQ_A), "blocked");
  assert.equal(evaluateLockOwnership([ticket({ status: "used" })], REQ_A).ok, false);
});

test("P0.2 — ingresso já estornado/cancelado é terminal (não é tocado de novo)", () => {
  for (const status of ["refunded", "cancelled"]) {
    assert.equal(classifyTicketLock(ticket({ status }), REQ_A), "terminal");
  }
  const res = evaluateLockOwnership([ticket({ status: "refunded" }), ticket({ id: "tk_2" })], REQ_A);
  assert.equal(res.ok, true);
  assert.deepEqual(res.claimable, ["tk_2"]);
  assert.equal(res.terminal, 1);
});

test("P0.2 — pedido só com ingressos terminais não gera novo estorno", () => {
  const res = evaluateLockOwnership([ticket({ status: "refunded" })], REQ_A);
  assert.equal(res.ok, false);
  assert.match(res.reason, /elegíveis/);
});

test("P0.2 — estado inesperado (dono em ingresso issued) nunca é roubado", () => {
  assert.equal(classifyTicketLock(ticket({ status: "issued", refund_request_id: REQ_B }), REQ_A), "blocked");
});

test("P0.2 — duas solicitações concorrentes: só a dona enxerga a trava como própria", () => {
  const lockedByA = [ticket({ status: "refund_pending", refund_request_id: REQ_A })];
  assert.equal(evaluateLockOwnership(lockedByA, REQ_A).ok, true);
  assert.equal(evaluateLockOwnership(lockedByA, REQ_B).ok, false);
});

test("P0.2 — repetição da compensação: destravar duas vezes é no-op (idempotente por CAS de estado)", () => {
  // A 2ª execução encontra o ingresso já em 'issued' (terminal para a compensação):
  // não há nada a destravar — classifyTicketLock só reconhece 'own' em refund_pending.
  assert.equal(classifyTicketLock(ticket(), REQ_A), "claimable");
  assert.notEqual(classifyTicketLock(ticket({ status: "refunded" }), REQ_A), "own");
});

// ---------- C. Valor (P0.1 / P0.3) ----------

test("P0.1 — valor acima do pago é recusado", () => {
  const r = resolveRefundAmountCents({ requestAmountCents: 12000, paidCents: 10000, stripeRefundedCents: 0 });
  assert.equal(r.ok, false);
});

test("P0.1 — valor acima do saldo remanescente no Stripe é recusado", () => {
  const r = resolveRefundAmountCents({ requestAmountCents: 8000, paidCents: 10000, stripeRefundedCents: 5000 });
  assert.equal(r.ok, false);
});

test("P0.1 — estorno parcial permitido dentro do saldo", () => {
  const r = resolveRefundAmountCents({ requestAmountCents: 5000, paidCents: 10000, stripeRefundedCents: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.cents, 5000);
});

test("P0.1 — pagamento totalmente estornado no Stripe não gera novo estorno", () => {
  const r = resolveRefundAmountCents({ requestAmountCents: 1000, paidCents: 10000, stripeRefundedCents: 10000 });
  assert.equal(r.ok, false);
});

test("P0.1 — valor zero/negativo é recusado (solicitação inválida)", () => {
  assert.equal(resolveRefundAmountCents({ requestAmountCents: 0, paidCents: 10000, stripeRefundedCents: 0 }).ok, false);
  assert.equal(resolveRefundAmountCents({ requestAmountCents: -500, paidCents: 10000, stripeRefundedCents: 0 }).ok, false);
});
// P0.1 / P0.2 (patch Fase 1) — CORRELAÇÃO Stripe Refund ↔ RefundRequest.
//
// Exercita as MESMAS funções usadas pelo reconciler (expireStaleReservations) e
// pelo webhook (stripeWebhook). O que se prova aqui: identidade nunca é valor,
// data ou posição — e, sem identidade, não há associação nem novo estorno.
//
// Execução: npm run test:unit:refund

import test from "node:test";
import assert from "node:assert/strict";

import { associateRefundToRequest, associateRefundsToRequests } from "../../base44/shared/refundGuards.ts";

const REQ_A = "req_A";
const REQ_B = "req_B";
const PI = "pi_1";

const refund = (id, amount, over = {}) => ({
  id,
  amount,
  currency: "brl",
  status: "succeeded",
  payment_intent: PI,
  metadata: {},
  created: 1,
  ...over,
});

const request = (over = {}) => ({
  id: REQ_A,
  payment_id: "pay_1",
  order_id: "ord_1",
  event_id: "ev_1",
  amount_requested: 40,
  stripe_refund_id: null,
  ...over,
});

const achi = (refunds, req = request(), extra = {}) => associateRefundToRequest({
  refunds, request: req, paymentIntentId: PI, currency: "BRL", complete: true, ...extra,
});

// ---------- A.1 / A.2 — mesmo valor, solicitações diferentes ----------

test("A.1 — duas solicitações de MESMO valor: cada uma associa ao seu próprio estorno", () => {
  const refunds = [
    refund("re_1", 4000, { metadata: { refund_request_id: REQ_A } }),
    refund("re_2", 4000, { metadata: { refund_request_id: REQ_B } }),
  ];
  const a = achi(refunds, request({ id: REQ_A }));
  const b = achi(refunds, request({ id: REQ_B }));
  assert.equal(a.verdict, "matched");
  assert.equal(a.refund.id, "re_1");
  assert.equal(b.verdict, "matched");
  assert.equal(b.refund.id, "re_2");
});

test("A.2 — dois estornos de mesmo valor SEM identidade: nenhum é escolhido", () => {
  const refunds = [refund("re_1", 4000), refund("re_2", 4000)];
  const a = achi(refunds);
  assert.equal(a.verdict, "inconclusive");
  assert.match(a.reason, /sem identidade/i);
});

test("A.2b — estorno de valor idêntico ao solicitado NÃO é usado como identidade", () => {
  const refunds = [refund("re_1", 4000)]; // valor exato, sem metadata e sem ID gravado
  const a = achi(refunds);
  assert.notEqual(a.verdict, "matched");
  assert.equal(a.verdict, "inconclusive");
});

// ---------- A.3 / A.4 — recuperação quando o ID não foi gravado ----------

test("A.3 — estorno criado sem stripe_refund_id gravado é recuperado pela identidade do Stripe", () => {
  const refunds = [refund("re_9", 4000, { metadata: { refund_request_id: REQ_A } })];
  const a = achi(refunds, request({ stripe_refund_id: null }));
  assert.equal(a.verdict, "matched");
  assert.equal(a.refund.id, "re_9");
});

test("A.4 — webhook que chega ANTES da gravação do ID encontra a solicitação pela metadata", () => {
  const refunds = [refund("re_9", 4000, { metadata: { refund_request_id: REQ_A } })];
  const out = associateRefundsToRequests({
    refunds,
    requests: [request({ id: REQ_A, stripe_refund_id: null })],
    paymentIntentId: PI,
    currency: "BRL",
  });
  assert.equal(out.matched?.id, REQ_A);
  assert.equal(out.ambiguous, false);
});

test("A.4b — webhook sem nenhuma identidade NÃO associa (fallback temporal removido)", () => {
  const refunds = [refund("re_9", 4000)];
  const out = associateRefundsToRequests({
    refunds,
    requests: [request({ id: REQ_A, stripe_refund_id: null }), request({ id: REQ_B, stripe_refund_id: null })],
    paymentIntentId: PI,
    currency: "BRL",
  });
  assert.equal(out.matched, null);
  assert.equal(out.ambiguous, false);
});

// ---------- A.5 / A.6 — PaymentIntent, moeda e valor ----------

test("A.5 — estorno de outro PaymentIntent não é considerado", () => {
  const refunds = [refund("re_1", 4000, { payment_intent: "pi_outro", metadata: { refund_request_id: REQ_A } })];
  const a = achi(refunds);
  assert.notEqual(a.verdict, "matched");
});

test("A.5b — estorno gravado cujo metadata aponta OUTRA solicitação é recusado", () => {
  const refunds = [refund("re_1", 4000, { metadata: { refund_request_id: REQ_B } })];
  const a = achi(refunds, request({ stripe_refund_id: "re_1" }));
  assert.equal(a.verdict, "inconclusive");
});

test("A.6 — identidade correta com valor divergente é aceita (valor é verificação, não identidade)", () => {
  const refunds = [refund("re_1", 3333, { metadata: { refund_request_id: REQ_A } })];
  const a = achi(refunds);
  assert.equal(a.verdict, "matched");
  assert.equal(a.refund.amount, 3333);
});

test("A.6b — moeda divergente impede a associação", () => {
  const refunds = [refund("re_1", 4000, { currency: "usd", metadata: { refund_request_id: REQ_A } })];
  const a = achi(refunds);
  assert.equal(a.verdict, "inconclusive");
});

// ---------- A.8 / A.9 — repetição e duplicidade ----------

test("A.8 — associação repetida do mesmo estorno é estável (idempotente)", () => {
  const refunds = [refund("re_1", 4000, { metadata: { refund_request_id: REQ_A } })];
  const first = achi(refunds);
  const second = achi(refunds, request({ stripe_refund_id: "re_1" }));
  assert.equal(first.refund.id, second.refund.id);
  assert.equal(second.verdict, "matched");
});

test("A.9 — evento duplicado do webhook resolve para a mesma solicitação", () => {
  const refunds = [refund("re_1", 4000, { metadata: { refund_request_id: REQ_A } })];
  const args = { refunds, requests: [request({ id: REQ_A })], paymentIntentId: PI, currency: "BRL" };
  assert.equal(associateRefundsToRequests(args).matched?.id, associateRefundsToRequests(args).matched?.id);
});

test("A.9b — duas solicitações distintas no mesmo evento: ambíguo, nada é processado", () => {
  const refunds = [
    refund("re_1", 4000, { metadata: { refund_request_id: REQ_A } }),
    refund("re_2", 3000, { metadata: { refund_request_id: REQ_B } }),
  ];
  const out = associateRefundsToRequests({
    refunds,
    requests: [request({ id: REQ_A }), request({ id: REQ_B })],
    paymentIntentId: PI,
    currency: "BRL",
  });
  assert.equal(out.matched, null);
  assert.equal(out.ambiguous, true);
});

// ---------- A.10 — estorno manual no Stripe ----------

test("A.10 — estorno manual (sem solicitação interna) não é associado nem bloqueia por valor", () => {
  const refunds = [refund("re_manual", 10000)];
  const out = associateRefundsToRequests({
    refunds,
    requests: [request({ id: REQ_A })],
    paymentIntentId: PI,
    currency: "BRL",
  });
  assert.equal(out.matched, null);
  const a = achi(refunds);
  assert.equal(a.verdict, "inconclusive", "com estorno sem identidade no pagamento, não se cria outro");
});

// ---------- P1.3 — listagem incompleta ----------

test("P1.3 — listagem truncada nunca conclui ausência (não cria estorno)", () => {
  const a = achi([], request(), { complete: false });
  assert.equal(a.verdict, "inconclusive");
  const b = achi([]);
  assert.equal(b.verdict, "absent");
});

test("P1.3 — ID gravado fora da listagem (incompleta) é inconclusivo, não 'ausente'", () => {
  const a = achi([], request({ stripe_refund_id: "re_x" }));
  assert.equal(a.verdict, "inconclusive");
});
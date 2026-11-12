// P1.3 (patch Fase 1) — PAGINAÇÃO da consulta de estornos do Stripe.
//
// Exercita o laço de produção (base44/shared/pagination.ts, usado pelo
// stripeClient) com respostas simuladas da API: página posterior, erro na
// segunda página, limite operacional e resultado inconclusivo.
//
// Execução: npm run test:unit:refund

import test from "node:test";
import assert from "node:assert/strict";

import { collectPages } from "../../base44/shared/pagination.ts";
import { associateRefundsToRequests } from "../../base44/shared/refundGuards.ts";

const PI = "pi_1";
const req = (id, over = {}) => ({ id, payment_id: "pay_1", order_id: "ord_1", amount_requested: 40, stripe_refund_id: null, ...over });
const refund = (id, over = {}) => ({ id, amount: 4000, currency: "brl", status: "succeeded", payment_intent: PI, metadata: {}, ...over });

test("D.1 — mais de uma página: todos os itens são coletados", async () => {
  const calls = [];
  const pages = [
    { items: [{ id: "re_1" }, { id: "re_2" }], hasMore: true },
    { items: [{ id: "re_3" }], hasMore: false },
  ];
  const out = await collectPages(async (cursor) => {
    calls.push(cursor);
    return pages[calls.length - 1];
  });
  assert.equal(out.items.length, 3);
  assert.equal(out.complete, true);
  assert.equal(out.pages, 2);
  assert.deepEqual(calls, ["", "re_2"], "cursor avança pelo último item da página");
});

test("D.2 — estorno encontrado somente na página posterior é incluído", async () => {
  const out = await collectPages(async (cursor) => (
    cursor === ""
      ? { items: [{ id: "re_1" }], hasMore: true }
      : { items: [{ id: "re_alvo", metadata: { refund_request_id: "req_A" } }], hasMore: false }
  ));
  assert.equal(out.complete, true);
  assert.ok(out.items.some((r) => r.id === "re_alvo"));
});

test("D.3 — erro na segunda página é propagado (resultado inconclusivo)", async () => {
  let call = 0;
  await assert.rejects(
    () => collectPages(async () => {
      call++;
      if (call === 2) throw new Error("Stripe error 500");
      return { items: [{ id: "re_1" }], hasMore: true };
    }),
    /Stripe error 500/,
  );
});

test("D.4 — limite de páginas atingido com mais páginas: complete = false", async () => {
  const out = await collectPages(async () => ({ items: [{ id: `re_${Math.random()}` }], hasMore: true }), { maxPages: 3 });
  assert.equal(out.complete, false);
  assert.equal(out.pages, 3);
  assert.equal(out.items.length, 3);
});

test("D.5 — reexecução após falha de rede converge (mesma coleta, sem duplicar estado)", async () => {
  const out1 = await assert.rejects(() => collectPages(async () => { throw new TypeError("fetch failed"); }));
  assert.equal(out1, undefined);
  const out2 = await collectPages(async () => ({ items: [{ id: "re_1" }], hasMore: false }));
  assert.equal(out2.complete, true);
  assert.equal(out2.items.length, 1);
});

// P1.2 (patch final Fase 1) — comportamento invertido de propósito: página
// vazia COM has_more=true é listagem INCOMPLETA (o provedor afirma haver mais
// itens e nenhum cursor é derivável). Antes era declarada completa.
test("D.6 — página vazia com has_more=true é listagem INCOMPLETA (nunca completa)", async () => {
  const out = await collectPages(async () => ({ items: [], hasMore: true }));
  assert.equal(out.complete, false, "ausência não pode ser afirmada com has_more=true");
  assert.equal(out.pages, 1, "sem laço infinito");
  assert.equal(out.items.length, 0);
});

test("D.6b — página vazia com has_more=false encerra como completa", async () => {
  const out = await collectPages(async () => ({ items: [], hasMore: false }));
  assert.equal(out.complete, true);
  assert.equal(out.pages, 1);
});

// ---------- P1.1 — lista completa é pré-requisito da associação (webhook) ----------

test("P1.1 — lista completa com uma identidade válida associa", async () => {
  const listing = await collectPages(async () => ({
    items: [refund("re_1", { metadata: { refund_request_id: "req_A" } })],
    hasMore: false,
  }));
  assert.equal(listing.complete, true);
  const out = associateRefundsToRequests({
    refunds: listing.items, requests: [req("req_A")], paymentIntentId: PI, currency: "BRL", complete: listing.complete,
  });
  assert.equal(out.matched?.id, "req_A");
  assert.equal(out.incomplete, false);
});

test("P1.1 — evento com lista parcial (has_more=true) não associa nada", async () => {
  const out = associateRefundsToRequests({
    refunds: [refund("re_1", { metadata: { refund_request_id: "req_A" } })],
    requests: [req("req_A")],
    paymentIntentId: PI,
    currency: "BRL",
    complete: false,
  });
  assert.equal(out.matched, null, "sem a lista inteira não existe associação única");
  assert.equal(out.incomplete, true);
});

test("P1.1 — lista incompleta nunca resulta em associação arbitrária (mesmo com candidata na 1ª página)", () => {
  const refunds = [refund("re_1", { metadata: { refund_request_id: "req_A" } })];
  const args = { refunds, requests: [req("req_A")], paymentIntentId: PI, currency: "BRL" };
  assert.equal(associateRefundsToRequests({ ...args, complete: true }).matched?.id, "req_A");
  assert.equal(associateRefundsToRequests({ ...args, complete: false }).matched, null);
});

test("P1.1 — estorno relevante somente na página posterior é encontrado pela paginação", async () => {
  const listing = await collectPages(async (cursor) => (
    cursor === ""
      ? { items: [refund("re_manual")], hasMore: true }
      : { items: [refund("re_alvo", { metadata: { refund_request_id: "req_A" } })], hasMore: false }
  ));
  assert.equal(listing.complete, true);
  assert.ok(listing.items.some((r) => r.id === "re_alvo"));
  const out = associateRefundsToRequests({
    refunds: listing.items, requests: [req("req_A")], paymentIntentId: PI, currency: "BRL", complete: listing.complete,
  });
  assert.equal(out.matched?.id, "req_A");
});

test("P1.1 — falha ao buscar página adicional mantém a rodada inconclusiva", async () => {
  let call = 0;
  await assert.rejects(
    () => collectPages(async () => {
      call++;
      if (call === 2) throw new Error("Stripe error 500");
      return { items: [refund("re_1", { metadata: { refund_request_id: "req_A" } })], hasMore: true };
    }),
    /Stripe error 500/,
  );
  // O webhook trata a falha como lista incompleta: nada é associado.
  const out = associateRefundsToRequests({
    refunds: [refund("re_1", { metadata: { refund_request_id: "req_A" } })],
    requests: [req("req_A")],
    paymentIntentId: PI,
    currency: "BRL",
    complete: false,
  });
  assert.equal(out.matched, null);
});

test("P1.1 — dois estornos de solicitações distintas: ambíguo, nenhum ingresso é tocado", () => {
  const out = associateRefundsToRequests({
    refunds: [
      refund("re_1", { metadata: { refund_request_id: "req_A" } }),
      refund("re_2", { metadata: { refund_request_id: "req_B" } }),
    ],
    requests: [req("req_A"), req("req_B")],
    paymentIntentId: PI,
    currency: "BRL",
    complete: true,
  });
  assert.equal(out.matched, null);
  assert.equal(out.ambiguous, true);
});
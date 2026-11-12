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

const page = (items, hasMore) => async () => ({ items, hasMore });

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

test("D.6 — página vazia com has_more encerra como completa (sem laço infinito)", async () => {
  const out = await collectPages(async () => ({ items: [], hasMore: true }));
  assert.equal(out.complete, true);
  assert.equal(out.pages, 1);
  assert.equal(out.items.length, 0);
});
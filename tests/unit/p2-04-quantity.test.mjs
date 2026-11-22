// P2-04 (2026-11-22) — QUANTIDADE INTEIRA ESTRITA.
//
// Defeito original: `Math.floor(1.5)` → 1 (truncava em silêncio),
// `Math.max(1, Number(x) || 1)` e `parseInt(x) || 1` transformavam entrada
// inválida em valor válido. Aqui cada caso é verificado, e a integração com a
// reserva de estoque prova que a quantidade fracionária NÃO move saldo.

import test from "node:test";
import assert from "node:assert/strict";

import { parseQuantity, parseMoneyBRL, MAX_QUANTITY, MAX_MONEY_BRL } from "../../base44/shared/numericInput.ts";
import { reserveStockForCheckout, releaseReservation } from "../../base44/shared/stockReservation.ts";
import { createFakeDb } from "./lib/fakeDb.mjs";

const ok = (r) => assert.equal(r.ok, true, `esperava sucesso, veio ${r.reason}`);
const bad = (r, reason) => {
  assert.equal(r.ok, false, "esperava recusa");
  if (reason) assert.equal(r.reason, reason);
};

test("aceita inteiros positivos, texto de dígitos e o limite máximo", () => {
  assert.equal(parseQuantity(1).value, 1);
  assert.equal(parseQuantity(2).value, 2);
  assert.equal(parseQuantity(MAX_QUANTITY).value, MAX_QUANTITY);
  assert.equal(parseQuantity("12").value, 12);
  assert.equal(parseQuantity(" 7 ").value, 7);
});

test("recusa zero quando a operação exige positivo", () => {
  bad(parseQuantity(0), "zero");
  bad(parseQuantity("0"), "zero");
  ok(parseQuantity(0, { min: 0 }));
});

test("recusa negativos", () => {
  bad(parseQuantity(-1), "negativo");
  bad(parseQuantity("-3"), "negativo");
});

test("recusa fracionários (nunca trunca)", () => {
  bad(parseQuantity(1.5), "fracionario");
  bad(parseQuantity(0.1), "fracionario");
  bad(parseQuantity("1.5"), "formato_invalido");
  bad(parseQuantity("0.1"), "formato_invalido");
});

test("recusa NaN e infinitos", () => {
  bad(parseQuantity(NaN), "nan");
  bad(parseQuantity(Infinity), "infinito");
  bad(parseQuantity(-Infinity), "infinito");
});

test("recusa texto vazio, com letras, notação científica e hexadecimal", () => {
  bad(parseQuantity(""), "vazio");
  bad(parseQuantity("   "), "vazio");
  bad(parseQuantity("abc"), "formato_invalido");
  bad(parseQuantity("12abc"), "formato_invalido");
  bad(parseQuantity("1e3"), "formato_invalido");
  bad(parseQuantity("0x10"), "formato_invalido");
});

test("recusa tipos inesperados", () => {
  bad(parseQuantity(undefined), "ausente");
  bad(parseQuantity(null), "ausente");
  bad(parseQuantity(true), "tipo_invalido");
  bad(parseQuantity({}), "tipo_invalido");
  bad(parseQuantity([]), "tipo_invalido");
});

test("recusa valor acima do limite de negócio (não ajusta para o limite)", () => {
  bad(parseQuantity(MAX_QUANTITY + 1), "acima_do_maximo");
  bad(parseQuantity("999999999999999999999"), "fora_do_limite");
});

test("é determinístico: a mesma entrada produz o mesmo resultado", () => {
  assert.deepEqual(parseQuantity("5"), parseQuantity("5"));
  assert.deepEqual(parseQuantity(5), { ok: true, value: 5 });
});

test("dinheiro: precisão de duas casas, vírgula e zero", () => {
  assert.deepEqual(parseMoneyBRL("12.50"), { ok: true, value: 12.5, cents: 1250 });
  assert.deepEqual(parseMoneyBRL("12,5"), { ok: true, value: 12.5, cents: 1250 });
  assert.deepEqual(parseMoneyBRL("0"), { ok: true, value: 0, cents: 0 });
  assert.deepEqual(parseMoneyBRL(0), { ok: true, value: 0, cents: 0 });
  assert.deepEqual(parseMoneyBRL(12.5), { ok: true, value: 12.5, cents: 1250 });
  // aritmética inteira: 0.30 não carrega resíduo de ponto flutuante
  assert.deepEqual(parseMoneyBRL("0.30"), { ok: true, value: 0.3, cents: 30 });
});

test("dinheiro: recusa inválidos sem converter em zero", () => {
  bad(parseMoneyBRL("abc"), "formato_invalido");
  bad(parseMoneyBRL(""), "vazio");
  bad(parseMoneyBRL(NaN), "nan");
  bad(parseMoneyBRL(Infinity), "infinito");
  bad(parseMoneyBRL(-1), "negativo");
  bad(parseMoneyBRL("-1"), "formato_invalido");
  bad(parseMoneyBRL("12.345"), "formato_invalido");
  bad(parseMoneyBRL(12.345), "precisao");
  bad(parseMoneyBRL(MAX_MONEY_BRL + 1), "acima_do_maximo");
});

test("integração: demanda fracionária é recusada sem mover saldo nem criar registro", async () => {
  const lot = {
    id: "lot_1",
    event_id: "evt_1",
    quantity_total: 10,
    quantity_reserved: 0,
    quantity_sold: 0,
    is_active: true,
  };
  const db = createFakeDb({ salesLots: [lot] });
  const out = await reserveStockForCheckout(db.svc, {
    checkoutToken: "ck_frac",
    eventId: "evt_1",
    demandByLot: { lot_1: 1.5 },
    lotById: { lot_1: lot },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "quantidade_invalida");
  assert.equal(db.salesLots[0].quantity_reserved, 0);
  assert.equal(db.stockReservations.length, 0);
});

test("integração: quantidade acima do estoque é recusada pelo CAS do lote", async () => {
  const lot = {
    id: "lot_1",
    event_id: "evt_1",
    quantity_total: 2,
    quantity_reserved: 0,
    quantity_sold: 0,
    is_active: true,
  };
  const db = createFakeDb({ salesLots: [lot] });
  const out = await reserveStockForCheckout(db.svc, {
    checkoutToken: "ck_over",
    eventId: "evt_1",
    demandByLot: { lot_1: 3 },
    lotById: { lot_1: lot },
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "lot_unavailable");
  assert.equal(db.salesLots[0].quantity_reserved, 0);
});

test("integração: último item — a segunda reserva concorrente falha", async () => {
  const lot = {
    id: "lot_1",
    event_id: "evt_1",
    quantity_total: 1,
    quantity_reserved: 0,
    quantity_sold: 0,
    is_active: true,
  };
  const db = createFakeDb({ salesLots: [lot] });
  const first = await reserveStockForCheckout(db.svc, {
    checkoutToken: "ck_a",
    eventId: "evt_1",
    demandByLot: { lot_1: 1 },
    lotById: { lot_1: lot },
  });
  const second = await reserveStockForCheckout(db.svc, {
    checkoutToken: "ck_b",
    eventId: "evt_1",
    demandByLot: { lot_1: 1 },
    lotById: { lot_1: lot },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(db.salesLots[0].quantity_reserved, 1);
});

test("integração: liberação com quantidade fracionária não devolve estoque", async () => {
  const db = createFakeDb({
    salesLots: [{
      id: "lot_1",
      event_id: "evt_1",
      quantity_total: 10,
      quantity_reserved: 5,
      quantity_sold: 0,
      reservation_tokens: ["ck_bad"],
    }],
  });
  const out = await releaseReservation(
    db.svc,
    { id: "sr_1", checkout_token: "ck_bad", lot_id: "lot_1", quantity: 1.5, state: "active" },
    "teste",
  );
  assert.equal(out.released, false);
  assert.equal(out.reason, "reserva_sem_identidade");
  assert.equal(db.salesLots[0].quantity_reserved, 5, "saldo fracionário nunca é subtraído");
  assert.deepEqual(db.salesLots[0].reservation_tokens, ["ck_bad"]);
});

test("integração: liberação com quantidade inteira continua funcionando e é idempotente", async () => {
  const db = createFakeDb({
    salesLots: [{
      id: "lot_1",
      event_id: "evt_1",
      quantity_total: 10,
      quantity_reserved: 3,
      quantity_sold: 0,
      reservation_tokens: ["ck_ok"],
    }],
    stockReservations: [{
      id: "sr_ok", checkout_token: "ck_ok", lot_id: "lot_1", quantity: 2, state: "active", order_id: "ord_1",
    }],
  });
  const first = await releaseReservation(db.svc, db.stockReservations[0], "teste");
  const second = await releaseReservation(db.svc, db.stockReservations[0], "teste");
  assert.equal(first.released, true);
  assert.equal(second.released, false);
  assert.equal(db.salesLots[0].quantity_reserved, 1);
  assert.equal(db.stockReservations[0].state, "released");
});
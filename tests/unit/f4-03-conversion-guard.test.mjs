// F4-03 — CORREÇÃO FINAL DA CONVERSÃO DE ESTOQUE.
//
// Exercita o módulo de produção contra o banco falso (atomicidade POR DOCUMENTO
// e avaliação do filtro no instante da escrita).
//
// LIMITE DECLARADO: o banco falso NÃO reproduz latência de rede, réplica de
// leitura, timeout nem concorrência entre processos. Os testes de concorrência
// provam FÓRMULA (a escrita condicional admite um único vencedor por item), não
// o comportamento de um banco real — homologação continua pendente.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "./lib/fakeDb.mjs";
import {
  convertReservedToSoldOnce,
  orderTracksStockReservations,
} from "../../base44/shared/stockReservation.ts";
import { blocksFulfillment } from "../../base44/shared/commerceFulfillment.ts";

function lot(id, over = {}) {
  return {
    id,
    event_id: "ev_1",
    ticket_type_id: `tt_${id}`,
    name: `Lote ${id}`,
    price: 100,
    currency: "BRL",
    quantity_total: 10,
    quantity_reserved: 0,
    quantity_sold: 0,
    is_active: true,
    is_deleted: false,
    ...over,
  };
}

function dbWith(lots = [lot("lot_1", { quantity_reserved: 1 })]) {
  return createFakeDb({ salesLots: lots });
}

const item = (id = "it_1", lotId = "lot_1") => ({ id, lot_id: lotId, order_id: "ord_1" });

function reservedOf(db, id = "lot_1") {
  return db.salesLots.find((l) => l.id === id)?.quantity_reserved;
}

function soldOf(db, id = "lot_1") {
  return db.salesLots.find((l) => l.id === id)?.quantity_sold;
}

function markersOf(db, id = "lot_1") {
  return db.salesLots.find((l) => l.id === id)?.stock_converted_order_item_ids || [];
}

// Faz a LEITURA do lote falhar nas próximas `times` chamadas.
function withFlakyLotRead(db, times = 1) {
  const real = db.svc.entities.SalesLot.filter.bind(db.svc.entities.SalesLot);
  let left = times;
  db.svc.entities.SalesLot.filter = async (query = {}) => {
    if (left > 0) {
      left--;
      throw new Error("leitura indisponível");
    }
    return real(query);
  };
  return db;
}

// ---------------------------------------------------------------------------
// 1. Estoque reservado insuficiente (nunca negativo)
// ---------------------------------------------------------------------------
test("F4-03/1 — quantity_reserved = 0: falha explícita, nada convertido", async () => {
  const db = dbWith([lot("lot_1", { quantity_reserved: 0 })]);

  const out = await convertReservedToSoldOnce(db.svc, item());

  assert.equal(out.converted, false);
  assert.equal(out.reason, "reservado_insuficiente");
  assert.equal(reservedOf(db), 0, "reservado não vai a negativo");
  assert.equal(soldOf(db), 0, "nenhuma venda sem reserva correspondente");
  assert.deepEqual(markersOf(db), [], "item não é marcado como convertido");
});

test("F4-03/2 — quantity_reserved ausente: falha explícita, nada convertido", async () => {
  const db = dbWith([lot("lot_1")]);
  delete db.salesLots[0].quantity_reserved;

  const out = await convertReservedToSoldOnce(db.svc, item());

  assert.equal(out.converted, false);
  assert.equal(out.reason, "reservado_insuficiente");
  assert.equal(reservedOf(db), undefined, "campo não é criado nem vai a negativo");
  assert.equal(soldOf(db), 0);
  assert.deepEqual(markersOf(db), []);
});

test("F4-03/3 — quantity_reserved = 1: converte exatamente uma unidade", async () => {
  const db = dbWith([lot("lot_1", { quantity_reserved: 1, quantity_total: 5 })]);

  const out = await convertReservedToSoldOnce(db.svc, item());

  assert.equal(out.converted, true);
  assert.equal(out.reason, "convertido");
  assert.equal(reservedOf(db), 0);
  assert.equal(soldOf(db), 1);
  assert.deepEqual(markersOf(db), ["it_1"]);
});

// ---------------------------------------------------------------------------
// 2. Idempotência (retry / concorrência)
// ---------------------------------------------------------------------------
test("F4-03/4 — item já convertido em retry: nenhuma segunda conversão", async () => {
  const db = dbWith([lot("lot_1", { quantity_reserved: 1, quantity_total: 5 })]);
  await convertReservedToSoldOnce(db.svc, item());

  const retry = await convertReservedToSoldOnce(db.svc, item());

  assert.equal(retry.converted, false);
  assert.equal(retry.reason, "ja_convertido");
  assert.equal(soldOf(db), 1, "quantity_sold incrementado uma única vez");
  assert.equal(reservedOf(db), 0);
});

test("F4-03/5 — duas conversões concorrentes do mesmo item: um único vencedor", async () => {
  const db = dbWith([lot("lot_1", { quantity_reserved: 1, quantity_total: 5 })]);

  const [a, b] = await Promise.all([
    convertReservedToSoldOnce(db.svc, item()),
    convertReservedToSoldOnce(db.svc, item()),
  ]);

  assert.equal([a, b].filter((r) => r.converted).length, 1, "exatamente uma conversão efetiva");
  assert.equal(soldOf(db), 1, "nunca incrementa quantity_sold duas vezes");
  assert.equal(reservedOf(db), 0, "reservado consumido uma única vez");
  assert.deepEqual(markersOf(db), ["it_1"]);
});

test("F4-03/6 — retries repetidos nunca somam venda extra", async () => {
  const db = dbWith([lot("lot_1", { quantity_reserved: 4, quantity_total: 5 })]);

  await convertReservedToSoldOnce(db.svc, item("it_1"));
  await convertReservedToSoldOnce(db.svc, item("it_1"));
  await convertReservedToSoldOnce(db.svc, item("it_1"));

  assert.equal(soldOf(db), 1);
  assert.equal(reservedOf(db), 3, "as outras unidades reservadas ficam intactas");
});

// ---------------------------------------------------------------------------
// 3. Lote inexistente e falha de leitura
// ---------------------------------------------------------------------------
test("F4-03/7 — lote inexistente: falha explícita e nenhuma escrita", async () => {
  const db = dbWith([lot("lot_1", { quantity_reserved: 1 })]);

  const out = await convertReservedToSoldOnce(db.svc, item("it_1", "lot_inexistente"));

  assert.equal(out.converted, false);
  assert.equal(out.reason, "lote_inexistente");
  assert.equal(reservedOf(db), 1, "outro lote intocado");
  assert.equal(soldOf(db), 0);
});

test("F4-03/8 — retry após falha de LEITURA de confirmação não duplica a venda", async () => {
  const db = dbWith([lot("lot_1", { quantity_reserved: 1, quantity_total: 5 })]);
  await convertReservedToSoldOnce(db.svc, item());
  assert.equal(soldOf(db), 1);

  // Segunda tentativa: a escrita é no-op (item já convertido) e a LEITURA que
  // provaria a idempotência falha — nada é declarado; o retry confirma.
  withFlakyLotRead(db, 1);
  const failed = await convertReservedToSoldOnce(db.svc, item());
  assert.equal(failed.converted, false);
  assert.equal(failed.reason, "leitura_indisponivel");
  assert.equal(soldOf(db), 1, "nenhuma segunda venda por falta de confirmação");

  const retry = await convertReservedToSoldOnce(db.svc, item());
  assert.equal(retry.reason, "ja_convertido", "o retry conclui pela leitura do estado");
  assert.equal(soldOf(db), 1, "quantity_sold incrementado uma única vez");
  assert.equal(reservedOf(db), 0);
});

// ---------------------------------------------------------------------------
// 4. Fulfillment: reserva identificada x pedido legado
// ---------------------------------------------------------------------------
test("F4-03/9 — lote inexistente com reserva identificada BLOQUEIA o fulfillment", async () => {
  const db = dbWith([lot("lot_1", { quantity_reserved: 1 })]);
  db.stockReservations.push({
    id: "sr_1",
    event_id: "ev_1",
    checkout_token: "T",
    order_id: "ord_1",
    lot_id: "lot_inexistente",
    quantity: 1,
    state: "active",
    is_deleted: false,
  });

  const tracked = await orderTracksStockReservations(db.svc, "ord_1");
  assert.equal(tracked, true, "o pedido tem reserva identificada");

  const out = await convertReservedToSoldOnce(db.svc, item("it_1", "lot_inexistente"));

  assert.equal(blocksFulfillment(out, tracked), true, "falha recuperável — pedido não conclui");
  assert.equal(soldOf(db), 0, "nenhuma venda registrada");
  assert.equal(reservedOf(db), 1, "nenhum estoque devolvido");
});

test("F4-03/10 — lote inexistente em pedido legado: comportamento anterior preservado", async () => {
  const db = dbWith([lot("lot_1", { quantity_reserved: 1 })]);

  const tracked = await orderTracksStockReservations(db.svc, "ord_1");
  assert.equal(tracked, false, "pedido sem StockReservation = legado");

  const out = await convertReservedToSoldOnce(db.svc, item("it_1", "lot_inexistente"));

  assert.equal(blocksFulfillment(out, tracked), false, "legado não é bloqueado pelo lote ausente");
  assert.equal(soldOf(db), 0, "e nenhuma venda fantasma é criada");
  assert.equal(reservedOf(db), 1);

  // Reserva insuficiente também não bloqueia o legado, e nunca gera negativo.
  const zero = await convertReservedToSoldOnce(
    dbWith([lot("lot_2", { quantity_reserved: 0 })]).svc,
    item("it_2", "lot_2"),
  );
  assert.equal(blocksFulfillment(zero, false), false);
});

test("F4-03/11 — reserva identificada: reserva insuficiente e escrita/leitura indisponíveis bloqueiam", async () => {
  const db = dbWith([lot("lot_1", { quantity_reserved: 0 })]);
  const insufficient = await convertReservedToSoldOnce(db.svc, item());

  assert.equal(insufficient.reason, "reservado_insuficiente");
  assert.equal(blocksFulfillment(insufficient, true), true);
  assert.equal(blocksFulfillment({ converted: false, reason: "conversao_indisponivel" }, true), true);
  assert.equal(blocksFulfillment({ converted: false, reason: "leitura_indisponivel" }, true), true);
  assert.equal(blocksFulfillment({ converted: false, reason: "ja_convertido" }, true), false);
  assert.equal(blocksFulfillment({ converted: true, reason: "convertido" }, true), false);
});

test("F4-03/12 — leitura das reservas do pedido indisponível não é confundida com legado", async () => {
  const db = dbWith();
  const real = db.svc.entities.StockReservation.filter.bind(db.svc.entities.StockReservation);
  db.svc.entities.StockReservation.filter = async () => { throw new Error("leitura indisponível"); };

  await assert.rejects(
    () => orderTracksStockReservations(db.svc, "ord_1"),
    /leitura indisponível/,
    "o chamador cai em pending_retry em vez de concluir como legado",
  );

  db.svc.entities.StockReservation.filter = real;
  assert.equal(await orderTracksStockReservations(db.svc, "ord_1"), false);
});
// F4-04 — BLOQUEIO DE FULFILLMENT COM CONVERSÃO DE ESTOQUE PENDENTE.
//
// Testes de INTEGRAÇÃO do fluxo completo: exercitam a função de produção
// `fulfillOrder()` ponta a ponta (emissão de ingresso + participante, conversão
// reservado→vendido, retomada e encerramento das reservas) contra o banco falso,
// que aplica `updateMany(query, update)` com a mesma semântica de escrita atômica
// por documento.
//
// LIMITE DECLARADO: o banco falso não reproduz latência de rede, réplica de
// leitura, timeout do provedor nem concorrência entre processos. Estes testes
// provam o FLUXO e as decisões de bloqueio — não substituem homologação com
// banco real e concorrência real.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "./lib/fakeDb.mjs";
import { fulfillOrder } from "../../base44/shared/commerceFulfillment.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function lot(over = {}) {
  return {
    id: "lot_1",
    event_id: "ev_1",
    ticket_type_id: "tt_1",
    name: "1º Lote",
    price: 100,
    currency: "BRL",
    quantity_total: 10,
    quantity_reserved: 1,
    quantity_sold: 0,
    reservation_tokens: ["T"],
    is_active: true,
    is_deleted: false,
    ...over,
  };
}

function order(over = {}) {
  return {
    id: "ord_1",
    event_id: "ev_1",
    buyer_user_id: "u_buyer",
    buyer_person_id: "per_buyer",
    buyer_name: "Comprador",
    buyer_email: "comprador@example.com",
    status: "pending",
    total: 100,
    fulfillment_status: "pending",
    is_deleted: false,
    ...over,
  };
}

function payment(over = {}) {
  return {
    id: "pay_1",
    order_id: "ord_1",
    event_id: "ev_1",
    buyer_user_id: "u_buyer",
    intent_id: "pi_1",
    amount: 100,
    currency: "BRL",
    status: "pending",
    fulfillment_status: "pending",
    is_deleted: false,
    ...over,
  };
}

function item(id = "it_1", lotId = "lot_1", over = {}) {
  return {
    id,
    order_id: "ord_1",
    lot_id: lotId,
    ticket_type_id: "tt_1",
    ticket_type_name: "Ingresso",
    holder_name: "Ana Silva",
    holder_email: "ana@example.com",
    is_deleted: false,
    ...over,
  };
}

function reservation(over = {}) {
  return {
    id: "sr_1",
    event_id: "ev_1",
    checkout_token: "T",
    user_id: "u_buyer",
    order_id: "ord_1",
    lot_id: "lot_1",
    quantity: 1,
    state: "active",
    expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    is_deleted: false,
    ...over,
  };
}

function makeDb({ salesLots, orders, payments, orderItems, stockReservations, tickets } = {}) {
  return createFakeDb({
    salesLots: salesLots || [lot()],
    orders: orders || [order()],
    payments: payments || [payment()],
    orderItems: orderItems || [item()],
    stockReservations: stockReservations === undefined ? [reservation()] : stockReservations,
    tickets: tickets || [],
    events: [{ id: "ev_1", name: "Evolve Summit", is_deleted: false }],
  });
}

// Executa o fulfillment como o retry real faz: o claim é reaberto
// (fulfillment_status 'pending') sobre o MESMO pagamento.
async function run(db) {
  const pay = { ...db.payments[0], fulfillment_status: "pending" };
  const items = db.orderItems.filter((i) => !i.is_deleted);
  return fulfillOrder(db.svc, pay, db.orders[0], items);
}

function soldOf(db, id = "lot_1") {
  return db.salesLots.find((l) => l.id === id)?.quantity_sold;
}

function reservedOf(db, id = "lot_1") {
  return db.salesLots.find((l) => l.id === id)?.quantity_reserved;
}

function tokensOf(db, id = "lot_1") {
  return db.salesLots.find((l) => l.id === id)?.reservation_tokens || [];
}

function assertBlocked(db, fragment) {
  assert.equal(db.payments[0].status, "succeeded", "pagamento permanece confirmado");
  assert.equal(db.payments[0].fulfillment_status, "pending_retry", "fulfillment fica pendente para retry");
  assert.equal(db.orders[0].fulfillment_status, "pending_retry");
  assert.notEqual(db.orders[0].status, "paid", "pedido NÃO é marcado como pago/entregue");
  if (fragment) {
    assert.match(String(db.payments[0].error_reason || ""), fragment);
  }
}

// ---------------------------------------------------------------------------
// 1 + 2. Primeira tentativa falha na conversão; retry converte o estoque
// ---------------------------------------------------------------------------
test("F4-04/1 — primeira tentativa cria o ingresso e falha na conversão: pedido NÃO conclui", async () => {
  const db = makeDb({ salesLots: [lot({ quantity_reserved: 0, reservation_tokens: ["T"] })] });

  const out = await run(db);

  assert.equal(out.fulfilled, false);
  assert.match(out.error, /reservado_insuficiente/);
  assert.equal(db.tickets.length, 1, "ingresso emitido uma única vez");
  assert.equal(soldOf(db), 0, "nenhuma venda sem reserva");
  assert.equal(db.participants.length, 0, "participante não é criado antes da conversão");
  assert.equal(db.stockReservations[0].state, "active", "reserva continua viva");
  assert.deepEqual(tokensOf(db), ["T"], "token preservado no lote");
  assertBlocked(db);
});

test("F4-04/2 — retry encontra o ingresso existente e converte o estoque", async () => {
  const db = makeDb({ salesLots: [lot({ quantity_reserved: 0, reservation_tokens: ["T"] })] });
  await run(db);
  assert.equal(soldOf(db), 0);

  // A reserva é recomposta (ex.: correção do lote) e o retry precisa converter
  // mesmo com o ingresso já existente.
  await db.svc.entities.SalesLot.update("lot_1", { quantity_reserved: 1 });

  const out = await run(db);

  assert.equal(out.fulfilled, true, "conversão confirmada: pedido conclui");
  assert.equal(soldOf(db), 1);
  assert.equal(reservedOf(db), 0);
  assert.equal(db.tickets.length, 1, "retry NÃO duplica ingresso");
  assert.equal(db.participants.length, 1, "retry NÃO duplica participante");
  assert.equal(db.stockReservations[0].state, "consumed", "reserva encerrada como venda");
  assert.deepEqual(tokensOf(db), []);
  assert.equal(db.orders[0].status, "paid");
  assert.equal(db.orders[0].fulfillment_status, "fulfilled");
});

// ---------------------------------------------------------------------------
// 3 + 4. Retry com lote inexistente / reserva insuficiente
// ---------------------------------------------------------------------------
test("F4-04/3 — retry com LOTE INEXISTENTE não conclui o pedido", async () => {
  const db = makeDb({
    salesLots: [lot({ id: "lot_1" })],
    orderItems: [item("it_1", "lot_sumido")],
    stockReservations: [reservation({ lot_id: "lot_sumido" })],
  });

  const out = await run(db);

  assert.equal(out.fulfilled, false);
  assert.match(out.error, /lote_inexistente/);
  assert.equal(soldOf(db), 0, "nenhuma venda registrada");
  assert.equal(reservedOf(db), 1, "estoque de terceiros intocado");
  assertBlocked(db);
});

test("F4-04/4 — retry com RESERVA INSUFICIENTE não conclui o pedido", async () => {
  const db = makeDb({
    salesLots: [lot({ quantity_reserved: 0, reservation_tokens: ["T"] })],
    tickets: [{
      id: "tk_prev", order_id: "ord_1", order_item_id: "it_1", event_id: "ev_1",
      lot_id: "lot_1", person_id: "per_1", participant_id: "", holder_name: "Ana Silva",
      holder_email: "ana@example.com", hash_code: "ABC", status: "issued", is_deleted: false,
    }],
  });

  const out = await run(db);

  assert.equal(out.fulfilled, false);
  assert.match(out.error, /reservado_insuficiente/);
  assert.equal(soldOf(db), 0);
  assert.equal(reservedOf(db), 0, "reservado não vai a negativo");
  assertBlocked(db);
});

// ---------------------------------------------------------------------------
// 5. Falha de leitura de Ticket / OrderItem
// ---------------------------------------------------------------------------
test("F4-04/5 — falha na consulta de TICKET não conclui o pedido", async () => {
  const db = makeDb();
  db.svc.entities.Ticket.filter = async () => { throw new Error("ingressos ilegíveis"); };

  const out = await run(db);

  assert.equal(out.fulfilled, false);
  assert.match(out.error, /ingressos ilegíveis/);
  assert.equal(db.tickets.length, 0, "nada é emitido sem conseguir conferir o que já existe");
  assert.equal(soldOf(db), 0, "nenhuma conversão sem estado confirmado");
  assertBlocked(db);
});

test("F4-04/5b — falha na consulta de ORDER ITEM na retomada não conclui o pedido", async () => {
  const db = makeDb({ stockReservations: [reservation()] });
  db.svc.entities.OrderItem.filter = async () => { throw new Error("itens ilegíveis"); };

  const out = await run(db);

  assert.equal(out.fulfilled, false);
  assert.match(out.error, /retomada indisponível/);
  assert.equal(db.stockReservations[0].state, "active", "reserva não é encerrada sem confirmação");
  assert.deepEqual(tokensOf(db), ["T"], "token preservado");
  assertBlocked(db);
});

// ---------------------------------------------------------------------------
// 6. Falha na retomada não é apenas registrada em log
// ---------------------------------------------------------------------------
test("F4-04/6 — falha na RETOMADA bloqueia o fulfillment (não é ignorada)", async () => {
  const db = makeDb({ salesLots: [lot({ quantity_reserved: 1 })] });

  // 1ª leitura (orderTracksStockReservations) funciona; a da retomada falha.
  const real = db.svc.entities.StockReservation.filter.bind(db.svc.entities.StockReservation);
  let calls = 0;
  db.svc.entities.StockReservation.filter = async (query = {}) => {
    calls++;
    if (calls === 1) return real(query);
    throw new Error("reservas ilegíveis");
  };

  const out = await run(db);

  assert.equal(out.fulfilled, false, "antes apenas registrava aviso e concluía");
  assert.match(out.error, /retomada indisponível/);
  assert.equal(soldOf(db), 1, "a conversão do item aconteceu");
  assert.equal(db.stockReservations[0].state, "active", "reserva permanece VIVA");
  assert.deepEqual(tokensOf(db), ["T"]);
  assertBlocked(db);
});

// ---------------------------------------------------------------------------
// 7. Retry após conversão já realizada não duplica a venda
// ---------------------------------------------------------------------------
test("F4-04/7 — retry após conversão completa não duplica quantity_sold", async () => {
  const db = makeDb({ salesLots: [lot({ quantity_reserved: 1 })] });

  const first = await run(db);
  assert.equal(first.fulfilled, true);
  assert.equal(soldOf(db), 1);

  const second = await run(db);

  assert.equal(second.fulfilled, true, "retry idempotente conclui pelo marcador");
  assert.equal(soldOf(db), 1, "quantity_sold incrementado uma única vez");
  assert.equal(reservedOf(db), 0);
  assert.equal(db.tickets.length, 1);
  assert.equal(db.participants.length, 1);
});

// ---------------------------------------------------------------------------
// 8. Pedido legado (sem StockReservation)
// ---------------------------------------------------------------------------
test("F4-04/8 — pedido legado mantém o comportamento anterior, sem venda fictícia", async () => {
  const legacyWithLot = makeDb({
    salesLots: [lot({ quantity_reserved: 0, reservation_tokens: [] })],
    stockReservations: [],
  });

  const out = await run(legacyWithLot);

  assert.equal(out.fulfilled, true, "legado não é bloqueado por reserva inexistente");
  assert.equal(soldOf(legacyWithLot), 0, "nenhuma venda fantasma é criada");
  assert.equal(legacyWithLot.tickets.length, 1);
  assert.equal(legacyWithLot.participants.length, 1);
  assert.equal(legacyWithLot.orders[0].status, "paid");

  const legacyWithoutLot = makeDb({
    salesLots: [],
    orderItems: [item("it_1", "lot_antigo")],
    stockReservations: [],
  });

  const missing = await run(legacyWithoutLot);

  assert.equal(missing.fulfilled, true, "lote ausente não bloqueia pedido legado");
  assert.equal(legacyWithoutLot.tickets.length, 1);
});

// ---------------------------------------------------------------------------
// 9. Pedido com vários itens: só conclui com TODOS convertidos
// ---------------------------------------------------------------------------
test("F4-04/9 — pedido com vários itens só conclui quando todos estiverem convertidos", async () => {
  const db = makeDb({
    salesLots: [lot({ quantity_reserved: 1, reservation_tokens: ["T"] })],
    orderItems: [item("it_1"), item("it_2", "lot_1", { holder_name: "Bruno", holder_email: "bruno@example.com" })],
    stockReservations: [reservation({ quantity: 2 })],
  });

  const first = await run(db);

  assert.equal(first.fulfilled, false, "uma unidade não convertida já bloqueia o pedido");
  assert.equal(soldOf(db), 1, "apenas a unidade disponível foi convertida");
  assert.equal(reservedOf(db), 0);
  assert.equal(db.stockReservations[0].state, "active");
  assertBlocked(db);

  // A segunda unidade reservada é recomposta; o retry conclui tudo uma vez.
  await db.svc.entities.SalesLot.update("lot_1", { quantity_reserved: 1 });
  const second = await run(db);

  assert.equal(second.fulfilled, true);
  assert.equal(soldOf(db), 2, "cada item converte exatamente uma unidade");
  assert.equal(db.tickets.length, 2, "um ingresso por item, sem duplicidade");
  assert.equal(db.participants.length, 2, "um participante por ingresso");
  assert.equal(db.stockReservations[0].state, "consumed");
  assert.deepEqual(tokensOf(db), []);
});
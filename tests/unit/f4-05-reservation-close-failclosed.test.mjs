// F4-05 — FAIL-CLOSED NA LEITURA E NO ENCERRAMENTO DAS RESERVAS.
//
// Testes de INTEGRAÇÃO do fluxo completo: exercitam a função de produção
// `fulfillOrder()` ponta a ponta (emissão de ingresso + participante, conversão
// reservado→vendido, retomada e encerramento das reservas) contra o banco falso,
// que aplica `updateMany(query, update)` com a mesma semântica de escrita atômica
// por documento.
//
// DEFEITO COBERTO: `listOrderReservations()` devolvia `[]` em qualquer exceção,
// então uma falha de leitura em `consumeOrderReservations()` era interpretada como
// "não há reserva pendente" e o pedido era declarado cumprido sem que se soubesse
// se havia reserva por encerrar. Também foi coberto o caso de reserva com
// quantidade inválida/zero, que era encerrada sem nenhuma conversão comprovada.
//
// LIMITE DECLARADO: o banco falso não reproduz latência de rede, réplica de
// leitura, timeout do provedor nem concorrência entre processos. Estes testes
// provam o FLUXO e as decisões de bloqueio — não substituem homologação com banco
// real e concorrência real.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "./lib/fakeDb.mjs";
import { fulfillOrder } from "../../base44/shared/commerceFulfillment.ts";
import { consumeOrderReservations } from "../../base44/shared/stockReservation.ts";

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

function item(id = "it_1", over = {}) {
  return {
    id,
    order_id: "ord_1",
    lot_id: "lot_1",
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

function makeDb({ salesLots, orders, payments, orderItems, stockReservations } = {}) {
  return createFakeDb({
    salesLots: salesLots || [lot()],
    orders: orders || [order()],
    payments: payments || [payment()],
    orderItems: orderItems || [item()],
    stockReservations: stockReservations === undefined ? [reservation()] : stockReservations,
    events: [{ id: "ev_1", name: "Evolve Summit", is_deleted: false }],
  });
}

async function run(db) {
  const pay = { ...db.payments[0], fulfillment_status: "pending" };
  const items = db.orderItems.filter((i) => !i.is_deleted);
  return fulfillOrder(db.svc, pay, db.orders[0], items);
}

// Faz a N-ésima consulta de reservas (e as seguintes) falhar. As anteriores
// continuam funcionando — reproduz "a primeira consulta funciona, a segunda falha".
function failReservationReadFrom(db, failFromCall) {
  const column = db.svc.entities.StockReservation;
  const real = column.filter.bind(column);
  let calls = 0;
  column.filter = async (query = {}) => {
    calls++;
    if (calls >= failFromCall) throw new Error("leitura de reservas indisponível (simulado)");
    return real(query);
  };
  return () => { column.filter = async (query = {}) => real(query); };
}

const soldOf = (db) => db.salesLots.find((l) => l.id === "lot_1")?.quantity_sold;
const reservedOf = (db) => db.salesLots.find((l) => l.id === "lot_1")?.quantity_reserved;
const tokensOf = (db) => db.salesLots.find((l) => l.id === "lot_1")?.reservation_tokens || [];

function assertBlocked(db, fragment) {
  assert.equal(db.payments[0].status, "succeeded", "pagamento permanece confirmado");
  assert.equal(db.payments[0].fulfillment_status, "pending_retry", "fulfillment fica pendente para retry");
  assert.equal(db.orders[0].fulfillment_status, "pending_retry");
  assert.notEqual(db.orders[0].status, "paid", "pedido NÃO é marcado como pago/entregue");
  if (fragment) assert.match(String(db.payments[0].error_reason || ""), fragment);
}

// ---------------------------------------------------------------------------
// 1..4. Leitura de reservas falha durante consumeOrderReservations()
// ---------------------------------------------------------------------------
test("F4-05/1 — leitura de reservas falha só no encerramento: pedido NÃO conclui", async () => {
  const db = makeDb();
  // Consultas 1 e 2 (deteção de reserva + retomada) funcionam; a 3ª (encerramento) falha.
  failReservationReadFrom(db, 3);

  const out = await run(db);

  assert.equal(out.fulfilled, false, "falha de leitura NÃO é confirmação de encerramento");
  assert.match(String(out.error), /encerramento das reservas de estoque não confirmado/);
  assert.match(String(out.error), /reservas_ilegiveis/);

  // 2 + 3 + 4 — pagamento confirmado, pedido/pagamento em retry, reserva recuperável.
  assertBlocked(db);
  assert.equal(db.stockReservations[0].state, "active", "reserva permanece ATIVA");
  assert.deepEqual(tokensOf(db), ["T"], "token NÃO é removido do lote");
  assert.equal(reservedOf(db), 0, "reservado→vendido já convertido");
  assert.equal(soldOf(db), 1, "a conversão do item aconteceu e não é desfeita");
  assert.equal(db.tickets.length, 1, "ingresso emitido uma única vez");
  assert.equal(db.participants.length, 1, "participante emitido uma única vez");
});

test("F4-05/2 — consulta indisponível não devolve pending: 0 como sucesso", async () => {
  const db = makeDb();
  failReservationReadFrom(db, 1);

  const out = await consumeOrderReservations(db.svc, "ord_1");

  assert.equal(out.unavailable, true);
  assert.equal(out.consumed, 0);
  assert.equal(out.pending, 0, "zero pendente por falha de leitura não é conclusão");
  assert.ok(out.reasons.length > 0, "o motivo da indisponibilidade é reportado");
});

// ---------------------------------------------------------------------------
// 5. Retry após normalização da leitura conclui sem duplicar vendas
// ---------------------------------------------------------------------------
test("F4-05/3 — retry após a leitura ser normalizada conclui sem duplicar vendas", async () => {
  const db = makeDb();
  const restore = failReservationReadFrom(db, 3);
  const blocked = await run(db);
  assert.equal(blocked.fulfilled, false);
  assert.equal(db.stockReservations[0].state, "active");

  restore();
  const retry = await run(db);

  assert.equal(retry.fulfilled, true, "com a leitura normalizada o pedido conclui");
  assert.equal(soldOf(db), 1, "venda não duplicada");
  assert.equal(reservedOf(db), 0);
  assert.equal(db.tickets.length, 1, "ingresso não duplicado");
  assert.equal(db.participants.length, 1, "participante não duplicado");
  assert.equal(db.stockReservations[0].state, "consumed", "reserva encerrada no retry");
  assert.deepEqual(tokensOf(db), [], "token removido apenas na conclusão");
  assert.equal(db.orders[0].status, "paid");
  assert.equal(db.orders[0].fulfillment_status, "fulfilled");
});

// ---------------------------------------------------------------------------
// 6. Reserva com quantidade inválida/zero não é consumida indevidamente
// ---------------------------------------------------------------------------
test("F4-05/4 — reserva com quantidade ZERO não é encerrada sem conversão comprovada", async () => {
  const db = makeDb({ stockReservations: [reservation({ quantity: 0 })] });

  const out = await run(db);

  assert.equal(out.fulfilled, false, "quantidade inválida bloqueia o encerramento");
  assert.match(String(out.error), /quantidade_invalida/);
  assert.equal(db.stockReservations[0].state, "active", "reserva NÃO é consumida às cegas");
  assert.deepEqual(tokensOf(db), ["T"], "token preservado no lote");
  assertBlocked(db);
});

test("F4-05/5 — reserva com quantidade ILEGÍVEL não é encerrada", async () => {
  const zero = makeDb({ stockReservations: [reservation({ quantity: 0 })] });
  const invalid = makeDb({ stockReservations: [reservation({ quantity: "abc" })] });
  const missing = makeDb({ stockReservations: [reservation({ quantity: undefined })] });

  for (const db of [zero, invalid, missing]) {
    const out = await consumeOrderReservations(db.svc, "ord_1");
    assert.equal(out.consumed, 0, "nenhuma reserva consumida");
    assert.equal(out.pending, 1, "o registro permanece pendente");
    assert.match(out.reasons.join(","), /quantidade_invalida/);
    assert.equal(db.stockReservations[0].state, "active");
    assert.deepEqual(tokensOf(db), ["T"]);
  }
});

test("F4-05/5b — falha ao conferir as unidades convertidas não encerra a reserva", async () => {
  const db = makeDb();
  db.svc.entities.OrderItem.filter = async () => { throw new Error("itens ilegíveis"); };

  const out = await consumeOrderReservations(db.svc, "ord_1");

  assert.equal(out.unavailable, true, "leitura indisponível é reportada como tal");
  assert.equal(out.consumed, 0);
  assert.equal(out.pending, 1);
  assert.match(out.reasons.join(","), /convertidas_ilegiveis/);
  assert.equal(db.stockReservations[0].state, "active");
  assert.deepEqual(tokensOf(db), ["T"]);
});

// ---------------------------------------------------------------------------
// 7. Consulta realmente vazia continua diferente de erro de consulta
// ---------------------------------------------------------------------------
test("F4-05/6 — consulta VAZIA conclui; consulta INDISPONÍVEL bloqueia", async () => {
  // (a) Sem reservas: leitura concluída e vazia = confirmação real.
  const legacy = makeDb({
    salesLots: [lot({ quantity_reserved: 0, reservation_tokens: [] })],
    stockReservations: [],
  });
  const empty = await consumeOrderReservations(legacy.svc, "ord_1");
  assert.equal(empty.unavailable, false, "lista vazia NÃO é indisponibilidade");
  assert.equal(empty.consumed, 0);
  assert.equal(empty.pending, 0);
  assert.deepEqual(empty.reasons, []);

  const legacyOut = await run(legacy);
  assert.equal(legacyOut.fulfilled, true, "pedido legado continua concluindo");
  assert.equal(soldOf(legacy), 0, "sem venda fictícia");

  // (b) Mesmo pedido, leitura indisponível: bloqueia.
  const broken = makeDb({ stockReservations: [] });
  failReservationReadFrom(broken, 1);
  const unavailable = await consumeOrderReservations(broken.svc, "ord_1");
  assert.equal(unavailable.unavailable, true, "a falha é distinguida da lista vazia");
  assert.equal(unavailable.pending, 0);
  assert.ok(unavailable.reasons.length > 0);

  const blocked = await run(broken);
  assert.equal(blocked.fulfilled, false, "sem prova de ausência de reserva, não conclui");
  // A própria detecção de reserva já falha aqui: o pedido nem chega ao
  // encerramento e o erro original é preservado no motivo do retry.
  assertBlocked(broken, /reservas_ilegiveis|leitura de reservas indisponível/);
});
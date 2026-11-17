// F4-01 (AUD-01) — TESTES DA RESERVA DE ESTOQUE IDENTIFICADA.
//
// Exercita o módulo de produção `base44/shared/stockReservation.ts` contra o
// banco falso, que aplica `updateMany(query, update)` com a MESMA semântica de
// uma escrita atômica por documento do banco real.
//
// LIMITE DECLARADO: o banco falso reproduz a atomicidade POR DOCUMENTO e a
// avaliação do filtro no instante da escrita. Ele NÃO reproduz latência de rede,
// réplica de leitura, timeout do provedor nem concorrência entre processos. Os
// testes de concorrência aqui provam FÓRMULA (cada token devolve só o seu), não
// comportamento do banco real — essa validação continua pendente de homologação.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb } from "./lib/fakeDb.mjs";
import {
  newCheckoutToken,
  reserveStockForCheckout,
  releaseCheckoutReservations,
  releaseReservation,
  releaseReservationsForOrderItem,
  attachReservationsToOrder,
  consumeOrderReservations,
  reconcileStockReservations,
  convertReservedToSoldOnce,
  resumeOrderStockConversion,
  assessOrderPaymentState,
  isPaymentProtected,
} from "../../base44/shared/stockReservation.ts";

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

function makeDb(lots = [lot("lot_1")], over = {}) {
  return createFakeDb({ salesLots: lots, ...over });
}

function reserve(db, token, demandByLot, opts = {}) {
  return reserveStockForCheckout(db.svc, {
    checkoutToken: token,
    eventId: "ev_1",
    userId: "user_1",
    demandByLot,
    lotById: Object.fromEntries(db.salesLots.map((l) => [l.id, l])),
    ...opts,
  });
}

function reservedOf(db, id = "lot_1") {
  return db.salesLots.find((l) => l.id === id).quantity_reserved;
}

function tokensOf(db, id = "lot_1") {
  return db.salesLots.find((l) => l.id === id).reservation_tokens || [];
}

function soldOf(db, id = "lot_1") {
  return db.salesLots.find((l) => l.id === id).quantity_sold;
}

function markersOf(db, id = "lot_1") {
  return db.salesLots.find((l) => l.id === id).stock_converted_order_item_ids || [];
}

// ---------------------------------------------------------------------------
// Reserva identificada
// ---------------------------------------------------------------------------
test("F4-01/1 — reserva grava token no lote e registro durável 'active'", async () => {
  const db = makeDb();
  const token = newCheckoutToken();

  const out = await reserve(db, token, { lot_1: 2 });

  assert.equal(out.ok, true);
  assert.equal(reservedOf(db), 2, "estoque reservado");
  assert.deepEqual(tokensOf(db), [token], "token no MESMO documento do lote");
  assert.equal(db.stockReservations.length, 1, "registro durável da reserva");
  assert.equal(db.stockReservations[0].state, "active");
  assert.equal(db.stockReservations[0].checkout_token, token);
  assert.equal(db.stockReservations[0].quantity, 2);
  assert.equal(db.stockReservations[0].event_id, "ev_1");
});

test("F4-01/2 — lote esgotado: nenhuma reserva fica presa e o estoque anterior volta", async () => {
  const db = makeDb([lot("lot_1"), lot("lot_2", { quantity_total: 1, quantity_reserved: 1 })]);
  const token = newCheckoutToken();

  const out = await reserve(db, token, { lot_1: 1, lot_2: 1 });

  assert.equal(out.ok, false);
  assert.equal(out.reason, "lot_unavailable");
  assert.equal(out.failedLot, "lot_2");
  assert.equal(reservedOf(db, "lot_1"), 0, "reserva do lote anterior devolvida");
  assert.deepEqual(tokensOf(db, "lot_1"), []);
  assert.equal(db.stockReservations.filter((r) => r.state === "active").length, 0);
});

// ---------------------------------------------------------------------------
// Compensação (falhas intermediárias)
// ---------------------------------------------------------------------------
test("F4-01/3 — falha imediatamente após a reserva: compensação devolve o estoque", async () => {
  const db = makeDb();
  const token = newCheckoutToken();
  await reserve(db, token, { lot_1: 3 });

  const out = await releaseCheckoutReservations(db.svc, token, "provider_error");

  assert.equal(out.released, 1);
  assert.equal(reservedOf(db), 0);
  assert.deepEqual(tokensOf(db), []);
  assert.equal(db.stockReservations[0].state, "released");
  assert.equal(db.stockReservations[0].released_reason, "provider_error");
});

test("F4-01/4 — compensação repetida nunca devolve duas vezes (nem fica negativa)", async () => {
  const db = makeDb();
  const token = newCheckoutToken();
  await reserve(db, token, { lot_1: 2 });

  await releaseCheckoutReservations(db.svc, token, "provider_error");
  const twice = await releaseCheckoutReservations(db.svc, token, "provider_error");
  const third = await releaseCheckoutReservations(db.svc, token, "coupon_invalid");

  assert.equal(twice.released, 0);
  assert.equal(third.released, 0);
  assert.equal(reservedOf(db), 0, "estoque devolvido exatamente uma vez");
  assert.equal(db.stockReservations[0].released_reason, "provider_error", "motivo original preservado");
});

test("F4-01/5 — reserva de OUTRO checkout não é liberada por token alheio", async () => {
  const db = makeDb();
  const mine = newCheckoutToken();
  const other = newCheckoutToken();
  await reserve(db, mine, { lot_1: 2 });
  await reserve(db, other, { lot_1: 3 });

  // Token desconhecido não devolve nada.
  const forged = await releaseReservation(db.svc, {
    id: "fake",
    checkout_token: "ck_atacante",
    lot_id: "lot_1",
    quantity: 3,
  }, "forged");
  assert.equal(forged.released, false);
  assert.equal(reservedOf(db), 5, "nenhuma unidade de outro checkout foi tocada");

  // Registro com quantidade inflada também não drena o lote (guarda $gte).
  const inflated = await releaseReservation(db.svc, {
    id: "fake2",
    checkout_token: mine,
    lot_id: "lot_1",
    quantity: 99,
  }, "inflated");
  assert.equal(inflated.released, false);
  assert.equal(reservedOf(db), 5);

  // Liberar a MINHA reserva devolve exatamente a minha quantidade.
  const mineOut = await releaseCheckoutReservations(db.svc, mine, "provider_error");
  assert.equal(mineOut.released, 1);
  assert.equal(reservedOf(db), 3, "as 3 unidades do outro checkout permanecem");
  assert.deepEqual(tokensOf(db), [other]);
});

test("F4-01/6 — cada checkout concorrente devolve apenas a própria reserva", async () => {
  const db = makeDb();
  const a = newCheckoutToken();
  const b = newCheckoutToken();

  const [ra, rb] = await Promise.all([
    reserve(db, a, { lot_1: 2 }),
    reserve(db, b, { lot_1: 2 }),
  ]);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(reservedOf(db), 4);

  await Promise.all([
    releaseCheckoutReservations(db.svc, a, "concurrent_checkout"),
    releaseCheckoutReservations(db.svc, b, "concurrent_checkout"),
  ]);

  assert.equal(reservedOf(db), 0, "soma dos dois devolvida, sem duplicidade");
  assert.deepEqual(tokensOf(db), []);
  assert.equal(db.stockReservations.filter((r) => r.state === "released").length, 2);
});

test("F4-01/7 — retry do mesmo checkout: liberar a tentativa A não afeta a B", async () => {
  const db = makeDb();
  const first = newCheckoutToken();
  const second = newCheckoutToken();

  await reserve(db, first, { lot_1: 1 });
  await attachReservationsToOrder(db.svc, first, "ord_1");
  // Re-checkout: a tentativa anterior é liberada e uma nova reserva é feita.
  await releaseCheckoutReservations(db.svc, first, "checkout_reopened");
  await reserve(db, second, { lot_1: 1 });
  await attachReservationsToOrder(db.svc, second, "ord_1");

  assert.equal(reservedOf(db), 1, "apenas a reserva viva da tentativa nova");
  assert.deepEqual(tokensOf(db), [second]);
  assert.equal(db.stockReservations[0].state, "released");
  assert.equal(db.stockReservations[1].state, "active");
});

// ---------------------------------------------------------------------------
// Recuperação (reconciliação)
// ---------------------------------------------------------------------------
test("F4-01/8 — falha antes do pedido: reconciliação devolve a reserva órfã uma vez", async () => {
  const db = makeDb();
  const token = newCheckoutToken();
  await reserve(db, token, { lot_1: 2 }, { ttlMs: -1000 }); // já vencida

  const first = await reconcileStockReservations(db.svc, 10);
  assert.equal(first.released, 1);
  assert.equal(reservedOf(db), 0);
  assert.equal(db.stockReservations[0].state, "released");

  const second = await reconcileStockReservations(db.svc, 10);
  assert.equal(second.released, 0);
  assert.equal(reservedOf(db), 0, "nenhuma segunda devolução");
});

test("F4-01/9 — falha após criar o pedido (cancelado): reconciliação devolve a reserva", async () => {
  const db = makeDb([lot("lot_1")], {
    orders: [{ id: "ord_1", event_id: "ev_1", status: "cancelled", checkout_token: "T", is_deleted: false }],
  });
  const token = "T";
  await reserve(db, token, { lot_1: 1 }, { ttlMs: -1000 });
  await attachReservationsToOrder(db.svc, token, "ord_1");

  const out = await reconcileStockReservations(db.svc, 10);

  assert.equal(out.released, 1);
  assert.equal(reservedOf(db), 0);
  assert.equal(db.stockReservations[0].released_reason, "reconcile_order_ended");
});

test("F4-01/10 — reserva dentro da validade NÃO é liberada pela reconciliação", async () => {
  const db = makeDb();
  const token = newCheckoutToken();
  await reserve(db, token, { lot_1: 2 }); // validade de 15 min

  const out = await reconcileStockReservations(db.svc, 10);

  assert.equal(out.released, 0);
  assert.equal(out.kept, 1);
  assert.equal(reservedOf(db), 2, "nada foi devolvido por idade");
  assert.equal(db.stockReservations[0].state, "active");
});

test("F4-01/11 + F4-02/P2-1 — pagamento confirmado SEM ingresso emitido: reserva fica VIVA", async () => {
  const db = makeDb([lot("lot_1")], {
    orders: [{ id: "ord_1", event_id: "ev_1", status: "paid", checkout_token: "T", is_deleted: false }],
    payments: [{ id: "pay_1", order_id: "ord_1", event_id: "ev_1", status: "succeeded", is_deleted: false }],
  });
  const token = "T";
  await reserve(db, token, { lot_1: 2 }, { ttlMs: -1000 });
  await attachReservationsToOrder(db.svc, token, "ord_1");

  const out = await reconcileStockReservations(db.svc, 10);

  assert.equal(out.released, 0);
  assert.equal(out.kept, 1);
  assert.equal(out.pending, 1, "conversão incompleta é reportada (não é venda consolidada)");
  assert.equal(reservedOf(db), 2, "estoque de compra paga preservado");
  assert.deepEqual(tokensOf(db), [token], "token permanece: nenhuma unidade foi convertida");
  assert.equal(
    db.stockReservations[0].state, "active",
    "F4-02/P2 — pagamento confirmado não basta: a reserva só encerra com o lote convertido",
  );
});

test("F4-01/12 — pedido pendente dentro da janela de pagamento não é liberado", async () => {
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const db = makeDb([lot("lot_1")], {
    orders: [{ id: "ord_1", event_id: "ev_1", status: "pending", checkout_token: "T", reserved_until: future, is_deleted: false }],
  });
  const token = "T";
  await reserve(db, token, { lot_1: 1 }, { ttlMs: -1000 });
  await attachReservationsToOrder(db.svc, token, "ord_1");

  const out = await reconcileStockReservations(db.svc, 10);

  assert.equal(out.released, 0);
  assert.equal(reservedOf(db), 1);
});

test("F4-01/13 — falha intermediária: registro 'claiming' com token no lote é recuperado", async () => {
  const db = makeDb([lot("lot_1", { quantity_reserved: 1, reservation_tokens: ["T"] })]);
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  await db.svc.entities.StockReservation.create({
    event_id: "ev_1",
    checkout_token: "T",
    user_id: "user_1",
    order_id: "",
    lot_id: "lot_1",
    quantity: 1,
    state: "claiming",
    expires_at: past,
    is_deleted: false,
  });

  const out = await reconcileStockReservations(db.svc, 10);

  assert.equal(out.released, 1);
  assert.equal(reservedOf(db), 0);
  assert.equal(db.stockReservations[0].state, "released");
});

test("F4-01/14 — registro 'claiming' SEM token no lote (escrita não aconteceu) não decrementa nada", async () => {
  const db = makeDb([lot("lot_1", { quantity_reserved: 4 })]);
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  await db.svc.entities.StockReservation.create({
    event_id: "ev_1",
    checkout_token: "T",
    user_id: "user_1",
    order_id: "",
    lot_id: "lot_1",
    quantity: 2,
    state: "claiming",
    expires_at: past,
    is_deleted: false,
  });

  const out = await reconcileStockReservations(db.svc, 10);

  assert.equal(out.released, 0, "nada foi devolvido — o token não estava no lote");
  assert.equal(reservedOf(db), 4, "estoque de terceiros intocado");
  assert.equal(db.stockReservations[0].state, "released", "registro encerrado sem perda");
  assert.equal(db.stockReservations[0].released_reason, "reconcile_orphan:sem_estoque");
});

test("F4-01/15 — liberação por item é escopada ao pedido daquele item", async () => {
  const db = makeDb([lot("lot_1")], {
    orders: [
      { id: "ord_a", event_id: "ev_1", status: "cancelled", is_deleted: false },
      { id: "ord_b", event_id: "ev_1", status: "cancelled", is_deleted: false },
    ],
  });
  const tokenA = newCheckoutToken();
  const tokenB = newCheckoutToken();
  await reserve(db, tokenA, { lot_1: 1 });
  await reserve(db, tokenB, { lot_1: 1 });
  await attachReservationsToOrder(db.svc, tokenA, "ord_a");
  await attachReservationsToOrder(db.svc, tokenB, "ord_b");

  const handled = await releaseReservationsForOrderItem(
    db.svc,
    { order_id: "ord_a", lot_id: "lot_1" },
    "order_released",
  );

  assert.equal(handled, true);
  assert.equal(reservedOf(db), 1, "só a reserva do item do pedido A foi devolvida");
  assert.deepEqual(tokensOf(db), [tokenB]);
});

test("F4-01/16 — venda confirmada encerra a reserva SÓ com o lote integralmente convertido", async () => {
  const db = makeDb([lot("lot_1", { quantity_reserved: 2, reservation_tokens: ["T"] })], {
    orders: [{ id: "ord_1", event_id: "ev_1", status: "paid", checkout_token: "T", is_deleted: false }],
    orderItems: [
      { id: "it_1", order_id: "ord_1", lot_id: "lot_1", is_deleted: false },
      { id: "it_2", order_id: "ord_1", lot_id: "lot_1", is_deleted: false },
    ],
  });
  await db.svc.entities.StockReservation.create({
    event_id: "ev_1",
    checkout_token: "T",
    user_id: "user_1",
    order_id: "ord_1",
    lot_id: "lot_1",
    quantity: 2,
    state: "active",
    expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    is_deleted: false,
  });

  // Nada convertido: a reserva NÃO pode ser encerrada (F4-02/P2).
  const before = await consumeOrderReservations(db.svc, "ord_1");
  assert.equal(before.consumed, 0);
  assert.equal(before.pending, 1);

  // Conversão parcial (1 de 2 unidades): ainda não encerra.
  await convertReservedToSoldOnce(db.svc, db.orderItems[0]);
  const partial = await consumeOrderReservations(db.svc, "ord_1");
  assert.equal(partial.consumed, 0);
  assert.equal(db.stockReservations[0].state, "active");

  // Conversão completa: agora sim, terminal.
  await convertReservedToSoldOnce(db.svc, db.orderItems[1]);
  const out = await consumeOrderReservations(db.svc, "ord_1");

  assert.equal(out.consumed, 1);
  assert.equal(db.stockReservations[0].state, "consumed");
  assert.deepEqual(tokensOf(db), [], "token removido do lote");
  assert.equal(reservedOf(db), 0, "reservado→vendido, sem devolução");
  assert.equal(soldOf(db), 2, "as duas unidades viraram venda");

  // Depois de consumida, uma liberação não devolve nada.
  const late = await releaseCheckoutReservations(db.svc, "T", "late_release");
  assert.equal(late.released, 0);
  assert.equal(reservedOf(db), 0);
  assert.equal(soldOf(db), 2, "nenhuma devolução de estoque de compra paga");
});
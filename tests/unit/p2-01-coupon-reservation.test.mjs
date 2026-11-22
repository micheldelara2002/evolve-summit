// P2-01 (2026-11-22) — CICLO DE VIDA DURÁVEL DA RESERVA DE CUPOM.
//
// Defeito original: o uso era incrementado em `Coupon.uses_count` ANTES de o
// pedido existir; se o pedido falhasse, o uso ficava consumido sem nenhum
// pedido correspondente — cupom esgotado artificialmente e sem origem.
//
// Aqui se prova o ciclo `reserved → committed | released`, a liberação
// idempotente por CAS, o "exatamente um decremento" e a reconciliação
// fail-closed (nada é devolvido sem prova de ausência de pagamento).

import test from "node:test";
import assert from "node:assert/strict";

import {
  reserveCouponUsage,
  attachCouponReservation,
  releaseCouponReservation,
  commitCouponReservation,
  releaseCouponReservationsForOrder,
  commitCouponReservationsForOrder,
  reconcileCouponReservations,
  diagnoseLegacyCouponOrders,
} from "../../base44/shared/couponReservation.ts";
import { createFakeDb } from "./lib/fakeDb.mjs";

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 10 * 60_000).toISOString();

const coupon = (over = {}) => ({
  id: "cp_1", code: "PROMO10", max_uses: 3, uses_count: 0, is_deleted: false, ...over,
});

const reservation = (over = {}) => ({
  id: "cr_1",
  event_id: "evt_1",
  coupon_id: "cp_1",
  coupon_code: "PROMO10",
  order_id: "",
  checkout_token: "ck_1",
  correlation_id: "ck_1",
  state: "reserved",
  counter_reserved: true,
  counter_decremented: false,
  expires_at: PAST,
  is_deleted: false,
  ...over,
});

test("reserva consome o uso e grava o registro em 'reserved'", async () => {
  const db = createFakeDb({ coupons: [coupon()] });
  const out = await reserveCouponUsage(db.svc, {
    coupon: db.coupons[0], eventId: "evt_1", userId: "u1", checkoutToken: "ck_1", discount: 10,
  });
  assert.equal(out.ok, true);
  assert.equal(out.limited, true);
  assert.equal(db.coupons[0].uses_count, 1);
  assert.equal(db.couponReservations.length, 1);
  const row = db.couponReservations[0];
  assert.equal(row.state, "reserved");
  assert.equal(row.counter_reserved, true);
  assert.equal(row.counter_decremented, false);
  assert.equal(row.checkout_token, "ck_1");
  assert.equal(row.correlation_id, "ck_1", "correlação = token da tentativa");
  assert.equal(row.discount, 10);
  assert.ok(row.expires_at, "reserva tem validade explícita");
});

test("a MESMA tentativa não reserva duas vezes (idempotente por checkout_token)", async () => {
  const db = createFakeDb({ coupons: [coupon()] });
  const params = { coupon: db.coupons[0], eventId: "evt_1", checkoutToken: "ck_1" };
  const first = await reserveCouponUsage(db.svc, params);
  const second = await reserveCouponUsage(db.svc, params);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.reservation.id, first.reservation.id);
  assert.equal(db.couponReservations.length, 1);
  assert.equal(db.coupons[0].uses_count, 1, "o uso não é contado duas vezes");
});

test("cupom esgotado é recusado sem consumir uso e com a reserva encerrada", async () => {
  const db = createFakeDb({ coupons: [coupon({ uses_count: 3 })] });
  const out = await reserveCouponUsage(db.svc, {
    coupon: db.coupons[0], eventId: "evt_1", checkoutToken: "ck_full",
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "coupon_exhausted");
  assert.equal(db.coupons[0].uses_count, 3, "o teto nunca é ultrapassado");
  assert.equal(db.couponReservations[0].state, "released");
  assert.equal(db.couponReservations[0].released_reason, "coupon_exhausted");
});

test("cupom ilimitado registra a reserva sem consumir teto", async () => {
  const db = createFakeDb({ coupons: [coupon({ max_uses: 0 })] });
  const out = await reserveCouponUsage(db.svc, {
    coupon: db.coupons[0], eventId: "evt_1", checkoutToken: "ck_free",
  });
  assert.equal(out.ok, true);
  assert.equal(out.limited, false);
  assert.equal(db.coupons[0].uses_count, 0);
  assert.equal(db.couponReservations[0].counter_reserved, false);
});

test("falha depois da reserva devolve o uso EXATAMENTE uma vez", async () => {
  const db = createFakeDb({ coupons: [coupon()] });
  const reserved = await reserveCouponUsage(db.svc, {
    coupon: db.coupons[0], eventId: "evt_1", checkoutToken: "ck_fail",
  });
  assert.equal(db.coupons[0].uses_count, 1);

  const first = await releaseCouponReservation(db.svc, reserved.reservation.id, "order_create_failed");
  const second = await releaseCouponReservation(db.svc, reserved.reservation.id, "order_create_failed");
  assert.equal(first.released, true);
  assert.equal(first.decremented, true);
  assert.equal(second.released, false, "repetir é no-op");
  assert.equal(db.coupons[0].uses_count, 0);
  assert.equal(db.couponReservations[0].state, "released");
  assert.equal(db.couponReservations[0].released_reason, "order_create_failed");
});

test("venda confirmada: reserva vira 'committed' e não é liberada por engano", async () => {
  const db = createFakeDb({ coupons: [coupon()] });
  const reserved = await reserveCouponUsage(db.svc, {
    coupon: db.coupons[0], eventId: "evt_1", checkoutToken: "ck_paid",
  });
  assert.equal(await attachCouponReservation(db.svc, reserved.reservation.id, "ord_1"), true);
  assert.equal(db.couponReservations[0].order_id, "ord_1");

  const committed = await commitCouponReservation(db.svc, reserved.reservation.id, "pagamento_confirmado");
  assert.equal(committed, true);
  assert.equal(db.couponReservations[0].state, "committed");
  assert.equal(db.coupons[0].uses_count, 1, "o uso permanece — a venda existe");

  const late = await releaseCouponReservation(db.svc, reserved.reservation.id, "order_released");
  assert.equal(late.released, false);
  assert.equal(late.reason, "estado_committed");
  assert.equal(db.coupons[0].uses_count, 1);
});

test("estorno integral reverte a reserva confirmada sem decrementar duas vezes", async () => {
  const db = createFakeDb({ coupons: [coupon()] });
  const reserved = await reserveCouponUsage(db.svc, {
    coupon: db.coupons[0], eventId: "evt_1", checkoutToken: "ck_refund",
  });
  await attachCouponReservation(db.svc, reserved.reservation.id, "ord_1");
  await commitCouponReservation(db.svc, reserved.reservation.id, "pagamento_confirmado");

  // O marcador do pedido já devolveu o uso; a reserva só registra o desfecho.
  const out = await releaseCouponReservation(db.svc, reserved.reservation.id, "refund", {
    allowCommitted: true,
    counterHandledBy: "order",
  });
  assert.equal(out.released, true);
  assert.equal(out.decremented, false);
  assert.equal(db.couponReservations[0].state, "released");
  assert.equal(db.coupons[0].uses_count, 1, "quem decrementa é o marcador do pedido");
});

test("encerramento por pedido trata todas as reservas do pedido", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 2 })],
    couponReservations: [
      reservation({ id: "cr_a", order_id: "ord_1", checkout_token: "ck_a" }),
      reservation({ id: "cr_b", order_id: "ord_1", checkout_token: "ck_b" }),
      reservation({ id: "cr_other", order_id: "ord_2", checkout_token: "ck_c" }),
    ],
  });
  const committed = await commitCouponReservationsForOrder(db.svc, "ord_1", "pagamento_confirmado");
  assert.equal(committed.committed, 2);
  assert.equal(db.couponReservations[2].state, "reserved", "outro pedido não é tocado");

  const released = await releaseCouponReservationsForOrder(
    db.svc,
    { id: "ord_1" },
    "refund",
    { allowCommitted: true, counterHandledBy: "order" },
  );
  assert.equal(released.released, 2);
  assert.equal(released.decremented, 0);
  assert.equal(db.coupons[0].uses_count, 2, "nenhum decremento duplo");
});

test("reconciliação: reserva órfã vencida devolve o uso", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 1 })],
    couponReservations: [reservation({ expires_at: PAST })],
  });
  const out = await reconcileCouponReservations(db.svc);
  assert.equal(out.released, 1);
  assert.equal(out.categories.sem_pedido, 1);
  assert.equal(db.couponReservations[0].state, "released");
  assert.equal(db.couponReservations[0].released_reason, "reconcile_orphan");
  assert.equal(db.coupons[0].uses_count, 0);
});

test("reconciliação: reserva órfã ainda válida é mantida", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 1 })],
    couponReservations: [reservation({ expires_at: FUTURE })],
  });
  const out = await reconcileCouponReservations(db.svc);
  assert.equal(out.kept, 1);
  assert.equal(out.released, 0);
  assert.equal(db.coupons[0].uses_count, 1);
  assert.equal(db.couponReservations[0].state, "reserved");
});

test("reconciliação: pagamento confirmado CONFIRMA a reserva (uso permanece)", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 1 })],
    orders: [{ id: "ord_1", event_id: "evt_1", status: "paid", is_deleted: false }],
    payments: [{ id: "pay_1", order_id: "ord_1", status: "succeeded", fulfillment_status: "fulfilled", is_deleted: false }],
    couponReservations: [reservation({ order_id: "ord_1" })],
  });
  const out = await reconcileCouponReservations(db.svc);
  assert.equal(out.committed, 1);
  assert.equal(out.categories.pagamento_confirmado, 1);
  assert.equal(db.couponReservations[0].state, "committed");
  assert.equal(db.coupons[0].uses_count, 1);
});

test("reconciliação: Pix em processamento é MANTIDO (dinheiro em trânsito)", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 1 })],
    orders: [{ id: "ord_1", event_id: "evt_1", status: "pending", reserved_until: PAST, is_deleted: false }],
    payments: [{ id: "pay_1", order_id: "ord_1", status: "pending", intent_id: "pi_1", is_deleted: false }],
    couponReservations: [reservation({ order_id: "ord_1" })],
  });
  const out = await reconcileCouponReservations(db.svc, 50, {
    retrieveIntent: async () => ({ status: "processing" }),
  });
  assert.equal(out.categories.processando, 1);
  assert.equal(out.released, 0);
  assert.equal(db.couponReservations[0].state, "reserved");
  assert.equal(db.coupons[0].uses_count, 1, "nada é devolvido sem prova de ausência de pagamento");
});

test("reconciliação: provedor indisponível é INDETERMINADO e nada é devolvido", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 1 })],
    orders: [{ id: "ord_1", event_id: "evt_1", status: "pending", reserved_until: PAST, is_deleted: false }],
    payments: [{ id: "pay_1", order_id: "ord_1", status: "pending", intent_id: "pi_1", is_deleted: false }],
    couponReservations: [reservation({ order_id: "ord_1" })],
  });
  const out = await reconcileCouponReservations(db.svc, 50, {
    retrieveIntent: async () => { throw new Error("rede indisponível"); },
  });
  assert.equal(out.categories.indeterminado, 1);
  assert.equal(out.released, 0);
  assert.equal(db.coupons[0].uses_count, 1);
});

test("reconciliação: pedido encerrado libera sem decrementar (o pedido já devolveu)", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 1 })],
    orders: [{ id: "ord_1", event_id: "evt_1", status: "cancelled", is_deleted: false }],
    couponReservations: [reservation({ order_id: "ord_1" })],
  });
  const out = await reconcileCouponReservations(db.svc);
  assert.equal(out.categories.pedido_encerrado, 1);
  assert.equal(out.released, 1);
  assert.equal(db.couponReservations[0].state, "released");
  assert.equal(db.coupons[0].uses_count, 1, "exatamente um decremento no app inteiro");
});

test("reconciliação: pedido pendente na janela de pagamento é mantido", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 1 })],
    orders: [{ id: "ord_1", event_id: "evt_1", status: "pending", reserved_until: FUTURE, is_deleted: false }],
    couponReservations: [reservation({ order_id: "ord_1" })],
  });
  const out = await reconcileCouponReservations(db.svc);
  assert.equal(out.categories.pedido_vivo, 1);
  assert.equal(out.released, 0);
  assert.equal(db.couponReservations[0].state, "reserved");
});

test("reconciliação: pedido pendente vencido NÃO antecipa o expirador", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 1 })],
    orders: [{ id: "ord_1", event_id: "evt_1", status: "pending", reserved_until: PAST, is_deleted: false }],
    couponReservations: [reservation({ order_id: "ord_1" })],
  });
  const out = await reconcileCouponReservations(db.svc);
  assert.equal(out.released, 0);
  assert.equal(db.couponReservations[0].state, "reserved");
});

test("reconciliação: leitura do pedido indisponível é fail-closed", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 1 })],
    couponReservations: [reservation({ order_id: "ord_1" })],
  });
  const svc = {
    entities: {
      ...db.svc.entities,
      Order: { filter: async () => { throw new Error("leitura indisponível"); } },
    },
  };
  const out = await reconcileCouponReservations(svc);
  assert.equal(out.unavailable, 1);
  assert.equal(out.released, 0);
  assert.equal(db.coupons[0].uses_count, 1);
  assert.equal(db.couponReservations[0].state, "reserved");
});

test("diagnóstico de pedidos legados não escreve nada", async () => {
  const db = createFakeDb({
    coupons: [coupon({ uses_count: 2 })],
    orders: [
      { id: "ord_legacy", event_id: "evt_1", coupon_id: "cp_1", coupon_uses_counted: true, is_deleted: false },
      { id: "ord_new", event_id: "evt_1", coupon_id: "cp_1", coupon_uses_counted: true, is_deleted: false },
    ],
    couponReservations: [reservation({ id: "cr_new", order_id: "ord_new", state: "committed" })],
  });
  const out = await diagnoseLegacyCouponOrders(db.svc);
  assert.equal(out.examined, 2);
  assert.equal(out.legacy, 1, "só o pedido sem reserva identificada é legado");
  assert.equal(out.unavailable, false);
  assert.equal(db.coupons[0].uses_count, 2, "diagnóstico não altera contador");
  assert.equal(db.couponReservations.length, 1);
});
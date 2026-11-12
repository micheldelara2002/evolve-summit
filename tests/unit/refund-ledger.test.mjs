// P1.1 / P1.2 (patch Fase 1) — LEDGER DE RESERVA DO ESTORNO.
//
// Exercita o MÓDULO DE PRODUÇÃO (base44/shared/refundLedger.ts) contra um banco
// fake com a mesma semântica de CAS do banco real: cada asserção é sobre o
// documento Payment depois das operações, não sobre uma cópia da lógica.
//
// Execução: npm run test:unit:refund

import test from "node:test";
import assert from "node:assert/strict";

import { createFakeDb, basePayment } from "./lib/fakeDb.mjs";
import {
  applyConfirmedRefundCents,
  availableRefundCents,
  claimRefundReservation,
  committedCents,
  confirmedCents,
  isLedgerReady,
  releaseRefundReservation,
  reservedCents,
} from "../../base44/shared/refundLedger.ts";

const REQ_A = "req_A";
const REQ_B = "req_B";

// ---------- B1 / B6 — teto e reservas simultâneas ----------

test("B1 — duas solicitações de R$ 40 em pagamento de R$ 100 reservam ambas", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment(); // mesmo estado lido pelas duas (corrida)
  const a = await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);
  const b = await claimRefundReservation(db.svc, snapshot, REQ_B, 4000);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(reservedCents(db.payment("pay_1")), 8000);
  assert.equal(confirmedCents(db.payment("pay_1")), 0);
  assert.equal(committedCents(db.payment("pay_1")), 8000);
  assert.deepEqual(db.payment("pay_1").refund_reservation_ids.sort(), [REQ_A, REQ_B]);
});

test("B6 — duas solicitações que juntas excedem o pago: a segunda é recusada", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  assert.equal((await claimRefundReservation(db.svc, snapshot, REQ_A, 6000)).ok, true);
  const second = await claimRefundReservation(db.svc, snapshot, REQ_B, 6000);
  assert.equal(second.ok, false);
  assert.equal(reservedCents(db.payment("pay_1")), 6000);
  assert.equal(committedCents(db.payment("pay_1")), 6000);
});

test("B5 — duas reservas concorrentes próximas do limite: exatamente uma vence", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  const [x, y] = await Promise.all([
    claimRefundReservation(db.svc, snapshot, REQ_A, 5000),
    claimRefundReservation(db.svc, snapshot, REQ_B, 5000),
  ]);
  assert.equal([x.ok, y.ok].filter(Boolean).length, 2); // 50 + 50 = 100 (cabe exato)
  const third = await claimRefundReservation(db.svc, snapshot, "req_C", 100);
  assert.equal(third.ok, false); // teto já comprometido
  assert.equal(committedCents(db.payment("pay_1")), 10000);
});

test("B5b — reservas concorrentes que juntas passariam do pago: só uma entra", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  const [x, y] = await Promise.all([
    claimRefundReservation(db.svc, snapshot, REQ_A, 6000),
    claimRefundReservation(db.svc, snapshot, REQ_B, 6000),
  ]);
  assert.equal([x.ok, y.ok].filter(Boolean).length, 1);
  assert.equal(committedCents(db.payment("pay_1")), 6000);
});

// ---------- B2 — confirmação de A com B pendente ----------

test("B2 — confirmar A mantém a reserva de B e o confirmado separado", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);
  await claimRefundReservation(db.svc, snapshot, REQ_B, 4000);

  const res = await applyConfirmedRefundCents(db.svc, snapshot, 4000, {
    releaseRequestId: REQ_A,
    releaseCents: 4000,
  });
  assert.equal(res.ok, true);

  const pay = db.payment("pay_1");
  assert.equal(confirmedCents(pay), 4000, "confirmado = valor devolvido pelo Stripe");
  assert.equal(pay.refunded_amount, 40);
  assert.equal(reservedCents(pay), 4000, "reserva de B continua representada");
  assert.equal(committedCents(pay), 8000, "confirmado + reservado = 80");
  assert.deepEqual(pay.refund_reservation_ids, [REQ_B], "só a reserva de A foi consumida");
});

// ---------- B3 / B4 — falha de uma solicitação com a outra pendente ----------

test("B3 — falha de A libera só a reserva de A e devolve capacidade", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 6000);
  await claimRefundReservation(db.svc, snapshot, REQ_B, 3000);

  const rel = await releaseRefundReservation(db.svc, "pay_1", REQ_A, 6000);
  assert.equal(rel.released, true);

  const pay = db.payment("pay_1");
  assert.equal(reservedCents(pay), 3000);
  assert.equal(committedCents(pay), 3000);
  assert.equal(confirmedCents(pay), 0, "falha não pode inventar valor confirmado");
  assert.deepEqual(pay.refund_reservation_ids, [REQ_B]);
  assert.equal(availableRefundCents(pay), 7000);
});

test("B4 — falha de B com A pendente não toca a reserva de A", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);
  await claimRefundReservation(db.svc, snapshot, REQ_B, 2000);
  await releaseRefundReservation(db.svc, "pay_1", REQ_B, 2000);
  const pay = db.payment("pay_1");
  assert.deepEqual(pay.refund_reservation_ids, [REQ_A]);
  assert.equal(committedCents(pay), 4000);
});

// ---------- P1.2 — liberação por identidade ----------

test("P1.2 — uma solicitação NÃO libera a reserva de outra", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);

  const stolen = await releaseRefundReservation(db.svc, "pay_1", REQ_B, 4000);
  assert.equal(stolen.released, false);
  assert.equal(committedCents(db.payment("pay_1")), 4000, "valor de A intacto");
  assert.deepEqual(db.payment("pay_1").refund_reservation_ids, [REQ_A]);
});

test("P1.2 — a mesma reserva não é liberada duas vezes (idempotente)", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);

  const first = await releaseRefundReservation(db.svc, "pay_1", REQ_A, 4000);
  const second = await releaseRefundReservation(db.svc, "pay_1", REQ_A, 4000);
  assert.equal(first.released, true);
  assert.equal(second.released, false);
  assert.equal(committedCents(db.payment("pay_1")), 0, "nunca fica negativo");
  assert.equal(reservedCents(db.payment("pay_1")), 0);
});

test("P1.2 — liberação concorrente da mesma reserva: exatamente uma executa", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);
  const [x, y] = await Promise.all([
    releaseRefundReservation(db.svc, "pay_1", REQ_A, 4000),
    releaseRefundReservation(db.svc, "pay_1", REQ_A, 4000),
  ]);
  assert.equal([x.released, y.released].filter(Boolean).length, 1);
  assert.equal(reservedCents(db.payment("pay_1")), 0);
});

test("P1.2 — falha não subtrai valor já confirmado pelo Stripe", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  // A é confirmado (40) sem reserva ativa; depois uma liberação qualquer não
  // pode mexer no confirmado.
  await applyConfirmedRefundCents(db.svc, snapshot, 4000);
  await releaseRefundReservation(db.svc, "pay_1", REQ_A, 4000);
  const pay = db.payment("pay_1");
  assert.equal(confirmedCents(pay), 4000);
  assert.equal(pay.refunded_amount, 40);
});

// ---------- B7 / B8 — convergência webhook × polling ----------

test("B7 — webhook duplicado não infla o confirmado nem o comprometido", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);

  await applyConfirmedRefundCents(db.svc, snapshot, 4000, { releaseRequestId: REQ_A, releaseCents: 4000 });
  const afterFirst = { ...db.payment("pay_1") };
  const again = await applyConfirmedRefundCents(db.svc, snapshot, 4000, { releaseRequestId: REQ_A, releaseCents: 4000 });

  assert.equal(again.applied, false);
  assert.equal(db.payment("pay_1").refunded_cents, afterFirst.refunded_cents);
  assert.equal(db.payment("pay_1").refund_committed_cents, afterFirst.refund_committed_cents);
});

test("B8 — polling e webhook simultâneos convergem para o mesmo confirmado", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);
  const opts = { releaseRequestId: REQ_A, releaseCents: 4000 };
  const [a, b] = await Promise.all([
    applyConfirmedRefundCents(db.svc, snapshot, 4000, opts),
    applyConfirmedRefundCents(db.svc, snapshot, 4000, opts),
  ]);
  assert.equal([a.applied, b.applied].filter(Boolean).length, 1);
  const pay = db.payment("pay_1");
  assert.equal(confirmedCents(pay), 4000);
  assert.equal(committedCents(pay), 4000, "confirmado sem reserva pendente");
});

test("B7b — evento fora de ordem (valor menor depois) não reduz o confirmado", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await applyConfirmedRefundCents(db.svc, snapshot, 6000);
  const stale = await applyConfirmedRefundCents(db.svc, snapshot, 4000);
  assert.equal(stale.ok, true);
  assert.equal(confirmedCents(db.payment("pay_1")), 6000);
});

test("P1.1 — confirmação sem associação ainda consome a reserva quando a solicitação é associada depois", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);

  // Webhook sem associação: aplica só o financeiro, reserva continua presa.
  await applyConfirmedRefundCents(db.svc, snapshot, 4000);
  assert.equal(reservedCents(db.payment("pay_1")), 4000);
  assert.equal(committedCents(db.payment("pay_1")), 8000);

  // Reconciliação posterior encontra a identidade e consome o token: o
  // confirmado não muda e a reserva não fica presa.
  await applyConfirmedRefundCents(db.svc, snapshot, 4000, { releaseRequestId: REQ_A, releaseCents: 4000 });
  const pay = db.payment("pay_1");
  assert.equal(confirmedCents(pay), 4000);
  assert.equal(reservedCents(pay), 0);
  assert.equal(committedCents(pay), 4000);
  assert.deepEqual(pay.refund_reservation_ids, []);
});

// ---------- B9 — resultado indeterminado (timeout) ----------

test("B9 — timeout mantém a reserva: nada é liberado por ausência de resposta", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);
  // Nenhuma liberação é chamada (o chamador trata timeout como indeterminado).
  const pay = db.payment("pay_1");
  assert.equal(reservedCents(pay), 4000);
  assert.equal(availableRefundCents(pay), 6000, "capacidade restante menor após reserva");
  const other = await claimRefundReservation(db.svc, snapshot, REQ_B, 7000);
  assert.equal(other.ok, false, "não é possível reservar além do saldo restante");
});

test("B10 — reexecução da compensação é no-op e o estado converge", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await claimRefundReservation(db.svc, snapshot, REQ_A, 4000);
  const first = await releaseRefundReservation(db.svc, "pay_1", REQ_A, 4000);
  const replay = await releaseRefundReservation(db.svc, "pay_1", REQ_A, 4000);
  assert.deepEqual([first.released, replay.released], [true, false]);
  assert.equal(reservedCents(db.payment("pay_1")), 0);
  assert.equal(committedCents(db.payment("pay_1")), 0);
});

// ---------- Estorno manual no Stripe (sem reserva) ----------

test("estorno manual no Stripe eleva o comprometido e fecha a capacidade", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  const snapshot = basePayment();
  await applyConfirmedRefundCents(db.svc, snapshot, 10000);
  const pay = db.payment("pay_1");
  assert.equal(confirmedCents(pay), 10000);
  assert.equal(committedCents(pay), 10000);
  assert.equal(availableRefundCents(pay), 0);
  const blocked = await claimRefundReservation(db.svc, snapshot, REQ_A, 100);
  assert.equal(blocked.ok, false);
});

// ---------- Normalização de pagamento legado ----------

test("pagamento legado (só refunded_amount) é normalizado no primeiro uso", async () => {
  const db = createFakeDb({ payments: [basePayment({ refunded_amount: 25, amount: 100 })] });
  const snapshot = basePayment({ refunded_amount: 25, amount: 100 });
  assert.equal(availableRefundCents(snapshot), 7500);
  const claim = await claimRefundReservation(db.svc, snapshot, REQ_A, 5000);
  assert.equal(claim.ok, true);
  const pay = db.payment("pay_1");
  assert.equal(confirmedCents(pay), 2500, "confirmado herdado do registro existente");
  assert.equal(reservedCents(pay), 5000);
  assert.equal(committedCents(pay), 7500);

  // P0.1 — o MESMO pagamento volta a operar normalmente depois de normalizado.
  assert.equal(isLedgerReady(pay), true);
  const next = await claimRefundReservation(db.svc, snapshot, REQ_B, 2000);
  assert.equal(next.ok, true);
  assert.equal(committedCents(db.payment("pay_1")), 9500);
});

// ---------- P0.1 (patch final Fase 1) — falha segura na normalização ----------

test("P0.1 — falha de escrita na normalização bloqueia a reserva sem tocar contadores", async () => {
  const legacy = basePayment({ refunded_amount: 25, amount: 100 });
  const db = createFakeDb({ payments: [legacy] });
  const calls = [];
  db.svc.entities.Payment.updateMany = async (q, u) => {
    calls.push({ q, u });
    throw new Error("escrita indisponível");
  };

  const claim = await claimRefundReservation(db.svc, { ...legacy }, REQ_A, 5000);
  assert.equal(claim.ok, false, "sem ledger normalizado não há reserva");
  assert.match(claim.reason, /ledger/i);
  assert.equal(calls.length, 1, "apenas a tentativa de normalização — nenhuma escrita de reserva");

  const pay = db.payment("pay_1");
  assert.equal(pay.refund_committed_cents, undefined, "contador de teto não foi criado");
  assert.equal(pay.refund_reserved_cents, undefined, "reservado não foi criado");
  assert.deepEqual(pay.refund_reservation_ids, undefined, "nenhum token de propriedade");
});

test("P0.1 — escrita aceita mas não persistida também bloqueia a reserva (leitura de volta inválida)", async () => {
  const db = createFakeDb({ payments: [basePayment()] });
  db.svc.entities.Payment.updateMany = async () => ({ updated: 1 }); // 'sucesso' sem efeito
  const claim = await claimRefundReservation(db.svc, basePayment(), REQ_A, 5000);
  assert.equal(claim.ok, false);
  assert.match(claim.reason, /não confirmado/i);
  assert.equal(db.payment("pay_1").refund_committed_cents, undefined);
});

test("P0.1 — contador de teto AUSENTE não é condição válida para reservar (não se assume zero)", async () => {
  // refunded_cents presente, refund_committed_cents ausente: a normalização não
  // casa (o campo já existe) e o gate sem contador permanece fechado.
  const partial = basePayment({ refunded_amount: 25, refunded_cents: 2500 });
  const db = createFakeDb({ payments: [partial] });
  const claim = await claimRefundReservation(db.svc, { ...partial }, REQ_A, 5000);
  assert.equal(claim.ok, false);
  assert.equal(db.payment("pay_1").refund_committed_cents, undefined);
  assert.deepEqual(db.payment("pay_1").refund_reservation_ids, undefined);
});

test("P0.1 — contadores inconsistentes recusam a reserva sem reescrever o registro", async () => {
  const broken = basePayment({ refunded_cents: 2500, refund_reserved_cents: 0, refund_committed_cents: 900 });
  const db = createFakeDb({ payments: [broken] });
  const writes = [];
  const original = db.svc.entities.Payment.updateMany.bind(db.svc.entities.Payment);
  db.svc.entities.Payment.updateMany = async (q, u) => { writes.push({ q, u }); return original(q, u); };

  const claim = await claimRefundReservation(db.svc, { ...broken }, REQ_A, 1000);
  assert.equal(claim.ok, false);
  assert.match(claim.reason, /inconsistente/i);
  assert.equal(writes.length, 0, "estado duvidoso não é 'corrigido' por conveniência");
  assert.equal(db.payment("pay_1").refund_committed_cents, 900);
});

test("P0.1 — legado com campos NULOS normaliza com leitura de volta válida e volta a reservar", async () => {
  const legacy = basePayment({
    refunded_amount: 25,
    refunded_cents: null,
    refund_reserved_cents: null,
    refund_committed_cents: null,
  });
  const db = createFakeDb({ payments: [legacy] });
  const claim = await claimRefundReservation(db.svc, { ...legacy }, REQ_A, 5000);
  assert.equal(claim.ok, true);
  const pay = db.payment("pay_1");
  assert.equal(isLedgerReady(pay), true);
  assert.equal(confirmedCents(pay), 2500, "confirmado herdado (nunca zero por omissão)");
  assert.equal(reservedCents(pay), 5000);
  assert.equal(committedCents(pay), 7500);
});
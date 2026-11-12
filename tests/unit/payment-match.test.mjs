// Fase 2 (2026-11-12) — identidade entre o evento do Stripe e o Payment.
//
// O webhook só pode emitir ingresso quando o Stripe confirmou exatamente o que
// o servidor cobrou. Estes testes fixam as quatro decisões da regra:
//   valor igual + moeda igual  → emite;
//   valor diferente            → NÃO emite;
//   moeda diferente            → NÃO emite;
//   Payment sem referência     → não bloqueia (checked: false), registrado.
//
// Puro: shared/paymentMatch.ts não importa SDK, rede nem banco.

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPaymentMatchesIntent, normalizeCurrency } from '../../base44/shared/paymentMatch.ts';

test('valor e moeda iguais ⇒ confere e libera', () => {
  const r = assertPaymentMatchesIntent({
    intentAmountCents: 15000,
    intentCurrency: 'brl',
    paymentAmountCents: 15000,
    paymentCurrency: 'BRL',
  });
  assert.equal(r.ok, true);
  assert.equal(r.checked, true);
  assert.equal(r.expectedCents, 15000);
  assert.equal(r.receivedCents, 15000);
});

test('valor maior que o pedido ⇒ recusa (não emite ingresso por valor não cobrado)', () => {
  const r = assertPaymentMatchesIntent({
    intentAmountCents: 15001,
    intentCurrency: 'brl',
    paymentAmountCents: 15000,
    paymentCurrency: 'brl',
  });
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /Valor divergente/);
});

test('valor menor que o pedido ⇒ recusa', () => {
  const r = assertPaymentMatchesIntent({
    intentAmountCents: 9999,
    intentCurrency: 'brl',
    paymentAmountCents: 15000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.receivedCents, 9999);
  assert.equal(r.expectedCents, 15000);
});

test('moeda divergente com mesmo valor ⇒ recusa', () => {
  const r = assertPaymentMatchesIntent({
    intentAmountCents: 15000,
    intentCurrency: 'usd',
    paymentAmountCents: 15000,
    paymentCurrency: 'brl',
  });
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /Moeda divergente/);
});

test('Payment sem amount_cents usa amount em reais como referência', () => {
  const r = assertPaymentMatchesIntent({
    intentAmountCents: 25000,
    intentCurrency: 'brl',
    paymentAmount: 250,
    paymentCurrency: 'brl',
  });
  assert.equal(r.ok, true);
  assert.equal(r.expectedCents, 25000);
});

test('Payment legado sem valor de referência não bloqueia, mas não confirma', () => {
  const r = assertPaymentMatchesIntent({
    intentAmountCents: 25000,
    intentCurrency: 'brl',
    paymentAmountCents: null,
    paymentAmount: null,
  });
  assert.equal(r.ok, true);
  assert.equal(r.checked, false);
});

test('PaymentIntent sem valor confirmado ⇒ recusa (não assume o esperado)', () => {
  const r = assertPaymentMatchesIntent({
    intentAmountCents: null,
    intentCurrency: 'brl',
    paymentAmountCents: 10000,
  });
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /sem valor confirmado/);
});

test('normalizeCurrency trata ausência e caixa', () => {
  assert.equal(normalizeCurrency('BRL'), 'brl');
  assert.equal(normalizeCurrency(undefined), '');
  assert.equal(normalizeCurrency(' Brl '), 'brl');
});

test('arredondamento de centavos não cria divergência falsa', () => {
  const r = assertPaymentMatchesIntent({
    intentAmountCents: '15000',
    intentCurrency: 'brl',
    paymentAmountCents: 15000.0,
    paymentCurrency: 'brl',
  });
  assert.equal(r.ok, true);
});
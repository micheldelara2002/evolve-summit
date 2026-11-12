// Fase 2 (2026-11-12) — identidade INEQUÍVOCA entre o evento do Stripe e o
// Payment gravado no checkout.
//
// O webhook só pode emitir ingresso quando o que o Stripe confirmou é
// exatamente o que o servidor cobrou: mesmo valor, mesma moeda. Sem essa
// checagem, um PaymentIntent criado com outro valor/moeda (parâmetro
// manipulado, catálogo alterado no meio do checkout, resposta de outro fluxo)
// liberaria o pedido por um valor que não foi pago.
//
// Puro de propósito: sem SDK, sem rede — testável por unidade.

export type PaymentMatchInput = {
  intentAmountCents?: number | string | null;
  intentCurrency?: string | null;
  paymentAmountCents?: number | string | null;
  paymentAmount?: number | string | null;
  paymentCurrency?: string | null;
};

export type PaymentMatchResult = {
  ok: boolean;
  checked: boolean;
  reason?: string;
  expectedCents?: number;
  receivedCents?: number;
  currency?: string;
};

function toInt(v: any): number | null {
  // null/undefined/vazio NÃO é zero: ausência de valor confirmado é ausência,
  // nunca "cobrou 0 centavos" (Number(null) === 0 esconderia o caso).
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

export function normalizeCurrency(v: any): string {
  return String(v || '').trim().toLowerCase();
}

/**
 * Confere valor e moeda do PaymentIntent com o Payment esperado.
 *
 * - `checked: false` quando o Payment não tem valor/moeda de referência
 *   (registros legados): não bloqueia, mas a ausência é registrada.
 * - Divergência de valor ou moeda ⇒ `ok: false` com motivo legível.
 */
export function assertPaymentMatchesIntent(input: PaymentMatchInput): PaymentMatchResult {
  const expectedCents =
    toInt(input.paymentAmountCents) ??
    (toInt(input.paymentAmount) !== null ? toInt(input.paymentAmount)! * 100 : null);
  const receivedCents = toInt(input.intentAmountCents);
  const expectedCurrency = normalizeCurrency(input.paymentCurrency) || 'brl';
  const receivedCurrency = normalizeCurrency(input.intentCurrency);

  if (expectedCents === null || expectedCents <= 0) {
    return {
      ok: true,
      checked: false,
      reason: 'Payment sem valor de referência — conferência de valor não aplicável.',
      receivedCents: receivedCents ?? undefined,
      currency: receivedCurrency || expectedCurrency,
    };
  }

  if (receivedCents === null) {
    return {
      ok: false,
      checked: true,
      reason: 'PaymentIntent sem valor confirmado.',
      expectedCents,
      currency: expectedCurrency,
    };
  }

  if (receivedCents !== expectedCents) {
    return {
      ok: false,
      checked: true,
      reason: `Valor divergente: cobrado ${receivedCents} centavos, esperado ${expectedCents}.`,
      expectedCents,
      receivedCents,
      currency: expectedCurrency,
    };
  }

  if (receivedCurrency && receivedCurrency !== expectedCurrency) {
    return {
      ok: false,
      checked: true,
      reason: `Moeda divergente: cobrado em ${receivedCurrency}, esperado ${expectedCurrency}.`,
      expectedCents,
      receivedCents,
      currency: expectedCurrency,
    };
  }

  return { ok: true, checked: true, expectedCents, receivedCents, currency: expectedCurrency };
}
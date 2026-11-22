// P2-04 (2026-11-22) — VALIDAÇÃO ESTRITA DE QUANTIDADE E DE VALOR MONETÁRIO.
//
// DEFEITO CORRIGIDO: quantidade de negócio era "sanitizada" com `Math.floor`
// (`1.5 → 1`), `Math.max(1, Number(x) || 1)` e `parseInt(x) || 1`. Esses padrões
// TRANSFORMAM entrada inválida em um valor válido em silêncio: o erro do cliente
// (ou do atacante) deixa de existir em vez de ser recusado, e o número gravado
// não é o número enviado.
//
// REGRA: entrada inválida é RECUSADA com motivo explícito. Nunca truncada,
// nunca arredondada, nunca substituída por default.
//
//   • aceita: inteiro finito (number) ou texto de dígitos ("12")
//   • recusa: NaN, Infinity/-Infinity, fracionário (1.5, 0.1), negativo,
//     zero quando a operação exige positivo, texto vazio, texto com letras
//     ("12abc", "1e3", "0x10"), booleano, objeto, acima do limite
//
// Os limites são de NEGÓCIO e explícitos: uma quantidade fora do limite é
// recusada, não "ajustada" para o limite.
//
// O mesmo módulo traz `parseMoneyBRL`, que converte valor monetário em CENTAVOS
// por aritmética inteira — nunca `valor * 100` em ponto flutuante, que produz
// 0.1+0.2 style drift em cálculo financeiro.

export const MAX_QUANTITY = 1_000_000;
export const MAX_MONEY_BRL = 1_000_000;

export type NumericOk<T> = { ok: true } & T;
export type NumericError = { ok: false; reason: string; error: string };
export type QuantityResult = NumericOk<{ value: number }> | NumericError;
export type MoneyResult = NumericOk<{ value: number; cents: number }> | NumericError;

export type QuantityOptions = {
  field?: string;
  /** Mínimo aceito. Default 1 (consumo/reserva exigem quantidade positiva). */
  min?: number;
  /** Máximo aceito. Default MAX_QUANTITY. */
  max?: number;
};

const SIGNED_INTEGER_TEXT = /^-?[0-9]+$/;
const MONEY_TEXT = /^[0-9]+(\.[0-9]{1,2})?$/;

function label(field: string): string {
  return field ? field.charAt(0).toUpperCase() + field.slice(1) : "Quantidade";
}

function fail(reason: string, error: string): NumericError {
  return { ok: false, reason, error };
}

/**
 * Quantidade inteira estrita. Nunca lança.
 */
export function parseQuantity(raw: unknown, options: QuantityOptions = {}): QuantityResult {
  const field = String(options.field || "quantidade");
  const min = options.min === undefined ? 1 : Number(options.min);
  const max = options.max === undefined ? MAX_QUANTITY : Number(options.max);
  const name = label(field);

  if (raw === undefined || raw === null) {
    return fail("ausente", `${name} não informada.`);
  }
  if (typeof raw === "boolean") {
    return fail("tipo_invalido", `${name} inválida.`);
  }

  let n: number;
  if (typeof raw === "number") {
    if (Number.isNaN(raw)) return fail("nan", `${name} inválida.`);
    if (!Number.isFinite(raw)) return fail("infinito", `${name} inválida.`);
    n = raw;
  } else if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return fail("vazio", `${name} não informada.`);
    if (!SIGNED_INTEGER_TEXT.test(text)) {
      // Cobre "1.5", "0.1", "12abc", "1e3", "0x10", " 1 2 ".
      return fail("formato_invalido", `${name} deve ser um número inteiro.`);
    }
    n = Number(text);
    if (!Number.isSafeInteger(n)) return fail("fora_do_limite", `${name} fora do limite permitido.`);
  } else {
    return fail("tipo_invalido", `${name} inválida.`);
  }

  if (!Number.isInteger(n)) return fail("fracionario", `${name} deve ser um número inteiro.`);
  if (n < 0) return fail("negativo", `${name} não pode ser negativa.`);
  if (n === 0 && min > 0) return fail("zero", `${name} deve ser maior que zero.`);
  if (n < min) return fail("abaixo_do_minimo", `${name} deve ser no mínimo ${min}.`);
  if (n > max) return fail("acima_do_maximo", `${name} não pode exceder ${max}.`);
  return { ok: true, value: n };
}

/**
 * Valor monetário em BRL → centavos (aritmética inteira). Nunca lança.
 * Aceita number finito ou texto decimal com até 2 casas ("12", "12.5", "12,50").
 */
export function parseMoneyBRL(
  raw: unknown,
  options: { field?: string; max?: number; allowZero?: boolean } = {},
): MoneyResult {
  const field = String(options.field || "valor");
  const max = options.max === undefined ? MAX_MONEY_BRL : Number(options.max);
  const allowZero = options.allowZero !== false;
  const name = label(field);

  let text = "";
  if (typeof raw === "number") {
    if (Number.isNaN(raw)) return fail("nan", `${name} inválido.`);
    if (!Number.isFinite(raw)) return fail("infinito", `${name} inválido.`);
    if (raw < 0) return fail("negativo", `${name} não pode ser negativo.`);
    // Converte para texto com 2 casas usando arredondamento de centavos (evita
    // 0.1+0.2 drift) e segue a MESMA validação de precisão do texto.
    const cents = Math.round(raw * 100);
    if (!Number.isSafeInteger(cents)) return fail("fora_do_limite", `${name} fora do limite permitido.`);
    if (Math.abs(cents / 100 - raw) > 1e-9) {
      return fail("precisao", `${name} deve ter no máximo duas casas decimais.`);
    }
    text = (cents / 100).toFixed(2);
  } else if (typeof raw === "string") {
    text = raw.trim().replace(",", ".");
    if (text === "") return fail("vazio", `${name} não informado.`);
  } else {
    return fail("tipo_invalido", `${name} inválido.`);
  }

  if (!MONEY_TEXT.test(text)) {
    return fail("formato_invalido", `${name} deve ser um número com até duas casas decimais.`);
  }

  const [intPart, fracPart = ""] = text.split(".");
  const intCents = Number(intPart) * 100;
  const fracCents = Number((fracPart + "00").slice(0, 2));
  const cents = intCents + fracCents;

  if (!Number.isSafeInteger(cents)) return fail("fora_do_limite", `${name} fora do limite permitido.`);
  if (cents === 0 && !allowZero) return fail("zero", `${name} deve ser maior que zero.`);
  if (cents > Math.round(max * 100)) {
    return fail("acima_do_maximo", `${name} não pode exceder R$ ${max.toLocaleString("pt-BR")}.`);
  }
  return { ok: true, value: cents / 100, cents };
}
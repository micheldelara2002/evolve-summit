// commerceValidation.ts — P0-A (2026-11-04)
//
// Validação SERVER-SIDE de domínio para a configuração comercial
// (TicketType, SalesLot, Coupon) e para a política de estorno do evento.
//
// Contexto: manageCommerce filtrava apenas por lista de campos permitidos e
// gravava o valor recebido sem checar tipo, faixa ou coerência entre campos.
// Preço negativo ou não finito, quantidade não inteira, janela de venda
// invertida, desconto acima de 100%, limite de usos abaixo do já consumido e
// quantidade total menor que vendida+reservada eram persistidos e só
// apareciam como efeito colateral no checkout.
//
// Princípios:
//   - Entrada inválida é RECUSADA (erro por campo; nada é gravado) — nunca
//     normalizada para um valor "próximo".
//   - Strings numéricas são aceitas e convertidas (formulários enviam texto);
//     booleano NÃO é coagido (true/false explícito ou ausente).
//   - Validação de existência/vínculo (tipo de ingresso do mesmo evento) é
//     feita pelo chamador, que tem acesso ao banco. Este módulo é puro.
//   - Update valida o registro RESULTANTE (existente + alterações), para que a
//     coerência entre campos não seja burlada editando um campo por vez.
//
// Limites adotados nesta entrega (itens 1 e 2 do §11 do plano de correção —
// decisões de negócio em aberto):
//   preço de lote e desconto fixo: R$ 0,00 – R$ 1.000.000,00
//   quantidade por lote:           0 – 1.000.000
//   código de cupom:               3 – 40 caracteres, A-Z 0-9 _ -
import { DEFAULT_GLOBAL_REFUND_POLICY } from "./commercePolicy.ts";

export const MAX_MONEY_BRL = 1_000_000;
export const MAX_LOT_QUANTITY = 1_000_000;
export const MIN_COUPON_CODE_LENGTH = 3;
export const MAX_COUPON_CODE_LENGTH = 40;
export const MAX_NAME_LENGTH = 120;
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_SORT_ORDER = 1_000_000;
export const MAX_REFUND_DAYS = 365;

const SUPPORTED_CURRENCIES = ["BRL"];
const COUPON_CODE_PATTERN = /^[A-Z0-9_-]+$/;

export type FieldError = { field: string; message: string };
export type ValidationResult =
  | { ok: true; data: Record<string, any> }
  | { ok: false; errors: FieldError[] };

function isPlainObject(v: any): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Número aceito: number finito ou string numérica não vazia. null = inválido.
function toNumber(v: any): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toInteger(v: any): number | null {
  const n = toNumber(v);
  if (n === null) return null;
  return Number.isInteger(n) ? n : null;
}

function toTimestamp(v: any): number | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function toText(v: any): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function has(payload: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

// ---------------------------------------------------------------------------
// TicketType
// ---------------------------------------------------------------------------
function validateTicketType(payload: any, existing: any): ValidationResult {
  const errors: FieldError[] = [];
  const out: Record<string, any> = {};
  const merged = { ...(existing || {}), ...payload };

  if (has(payload, "name") || !existing) {
    const name = toText(merged.name);
    if (!name) errors.push({ field: "name", message: "Informe o nome do tipo de ingresso." });
    else if (name.length > MAX_NAME_LENGTH) {
      errors.push({ field: "name", message: `O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.` });
    } else out.name = name;
  }

  if (has(payload, "description")) {
    if (payload.description === null || payload.description === "") out.description = "";
    else if (typeof payload.description !== "string") {
      errors.push({ field: "description", message: "Descrição inválida." });
    } else if (payload.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({ field: "description", message: `A descrição deve ter no máximo ${MAX_DESCRIPTION_LENGTH} caracteres.` });
    } else out.description = payload.description;
  }

  if (has(payload, "sort_order")) {
    const n = toInteger(payload.sort_order);
    if (n === null || Math.abs(n) > MAX_SORT_ORDER) {
      errors.push({ field: "sort_order", message: "Ordem de exibição deve ser um número inteiro." });
    } else out.sort_order = n;
  }

  if (has(payload, "is_active")) {
    if (typeof payload.is_active !== "boolean") {
      errors.push({ field: "is_active", message: "is_active deve ser booleano." });
    } else out.is_active = payload.is_active;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// SalesLot
// ---------------------------------------------------------------------------
function validateSalesLot(payload: any, existing: any): ValidationResult {
  const errors: FieldError[] = [];
  const out: Record<string, any> = {};
  const merged = { ...(existing || {}), ...payload };

  // Nome
  if (has(payload, "name") || !existing) {
    const name = toText(merged.name);
    if (!name) errors.push({ field: "name", message: "Informe o nome do lote." });
    else if (name.length > MAX_NAME_LENGTH) {
      errors.push({ field: "name", message: `O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.` });
    } else out.name = name;
  }

  // Tipo de ingresso (existência no evento é validada pelo chamador)
  if (has(payload, "ticket_type_id") || !existing) {
    const ttId = toText(merged.ticket_type_id);
    if (!ttId) errors.push({ field: "ticket_type_id", message: "Selecione o tipo de ingresso do lote." });
    else out.ticket_type_id = ttId;
  }

  // Preço
  if (has(payload, "price") || !existing) {
    const price = toNumber(merged.price);
    if (price === null) {
      errors.push({ field: "price", message: "Informe um preço válido." });
    } else if (price < 0) {
      errors.push({ field: "price", message: "O preço não pode ser negativo." });
    } else if (price > MAX_MONEY_BRL) {
      errors.push({ field: "price", message: `O preço não pode exceder R$ ${MAX_MONEY_BRL.toLocaleString("pt-BR")}.` });
    } else if (Math.abs(Math.round(price * 100) - price * 100) > 1e-6) {
      errors.push({ field: "price", message: "O preço deve ter no máximo duas casas decimais." });
    } else out.price = round2(price);
  }

  // Moeda
  if (has(payload, "currency")) {
    const cur = toText(payload.currency)?.toUpperCase();
    if (!cur || !SUPPORTED_CURRENCIES.includes(cur)) {
      errors.push({ field: "currency", message: `Moeda suportada: ${SUPPORTED_CURRENCIES.join(", ")}.` });
    } else out.currency = cur;
  } else if (!existing) {
    out.currency = "BRL";
  }

  // Janela de venda
  const startProvided = has(payload, "sale_start") || !existing;
  const endProvided = has(payload, "sale_end") || !existing;
  let startTs: number | null = null;
  let endTs: number | null = null;

  if (startProvided) {
    startTs = toTimestamp(merged.sale_start);
    if (startTs === null) errors.push({ field: "sale_start", message: "Informe a data de início da venda." });
    else out.sale_start = new Date(startTs).toISOString();
  }
  if (endProvided) {
    endTs = toTimestamp(merged.sale_end);
    if (endTs === null) errors.push({ field: "sale_end", message: "Informe a data de fim da venda." });
    else out.sale_end = new Date(endTs).toISOString();
  }
  // Coerência da janela: usa o valor resultante mesmo quando só um lado mudou.
  const finalStart = startTs ?? toTimestamp(merged.sale_start);
  const finalEnd = endTs ?? toTimestamp(merged.sale_end);
  if (finalStart !== null && finalEnd !== null && finalStart >= finalEnd) {
    errors.push({ field: "sale_end", message: "O fim da venda deve ser posterior ao início." });
  }

  // Quantidade
  if (has(payload, "quantity_total") || !existing) {
    const qty = toInteger(merged.quantity_total);
    if (qty === null) {
      errors.push({ field: "quantity_total", message: "Quantidade deve ser um número inteiro." });
    } else if (qty < 0) {
      errors.push({ field: "quantity_total", message: "A quantidade não pode ser negativa." });
    } else if (qty > MAX_LOT_QUANTITY) {
      errors.push({ field: "quantity_total", message: `A quantidade não pode exceder ${MAX_LOT_QUANTITY}.` });
    } else {
      // Nunca abaixo do que já foi vendido/reservado (evita saldo negativo).
      const reserved = toNumber(existing?.quantity_reserved) || 0;
      const sold = toNumber(existing?.quantity_sold) || 0;
      const committed = reserved + sold;
      if (qty < committed) {
        errors.push({
          field: "quantity_total",
          message: `A quantidade não pode ser menor que o já vendido/reservado (${committed}).`,
        });
      } else out.quantity_total = qty;
    }
  }

  if (has(payload, "is_active")) {
    if (typeof payload.is_active !== "boolean") {
      errors.push({ field: "is_active", message: "is_active deve ser booleano." });
    } else out.is_active = payload.is_active;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// Coupon
// ---------------------------------------------------------------------------
function validateCoupon(payload: any, existing: any): ValidationResult {
  const errors: FieldError[] = [];
  const out: Record<string, any> = {};
  const merged = { ...(existing || {}), ...payload };

  // Código (já normalizado para maiúsculas pelo chamador)
  if (has(payload, "code") || !existing) {
    const code = toText(merged.code)?.toUpperCase();
    if (!code) {
      errors.push({ field: "code", message: "Informe o código do cupom." });
    } else if (code.length < MIN_COUPON_CODE_LENGTH || code.length > MAX_COUPON_CODE_LENGTH) {
      errors.push({
        field: "code",
        message: `O código deve ter entre ${MIN_COUPON_CODE_LENGTH} e ${MAX_COUPON_CODE_LENGTH} caracteres.`,
      });
    } else if (!COUPON_CODE_PATTERN.test(code)) {
      errors.push({ field: "code", message: "Use apenas letras, números, hífen e sublinhado." });
    } else out.code = code;
  }

  // Tipo de desconto
  if (has(payload, "discount_type") || !existing) {
    const dt = toText(merged.discount_type);
    if (dt !== "percent" && dt !== "fixed") {
      errors.push({ field: "discount_type", message: "Tipo de desconto deve ser percent ou fixed." });
    } else out.discount_type = dt;
  }

  // Valor do desconto (faixa depende do tipo resultante)
  const finalType = out.discount_type ?? toText(merged.discount_type);
  if (has(payload, "value") || !existing || has(payload, "discount_type")) {
    const value = toNumber(merged.value);
    if (value === null) {
      errors.push({ field: "value", message: "Informe um valor de desconto válido." });
    } else if (value <= 0) {
      errors.push({ field: "value", message: "O valor do desconto deve ser maior que zero." });
    } else if (finalType === "percent" && value > 100) {
      errors.push({ field: "value", message: "O percentual de desconto não pode exceder 100%." });
    } else if (finalType === "fixed" && value > MAX_MONEY_BRL) {
      errors.push({ field: "value", message: `O desconto não pode exceder R$ ${MAX_MONEY_BRL.toLocaleString("pt-BR")}.` });
    } else out.value = round2(value);
  }

  // Escopo
  if (has(payload, "scope")) {
    const scope = toText(payload.scope);
    if (scope !== "per_ticket" && scope !== "per_cart") {
      errors.push({ field: "scope", message: "Escopo deve ser per_ticket ou per_cart." });
    } else out.scope = scope;
  } else if (!existing) {
    out.scope = "per_ticket";
  }

  // Janela de validade (ambos opcionais, mas coerentes quando presentes)
  if (has(payload, "valid_from")) {
    if (payload.valid_from === null || payload.valid_from === "") {
      out.valid_from = null;
    } else {
      const t = toTimestamp(payload.valid_from);
      if (t === null) errors.push({ field: "valid_from", message: "Data inicial inválida." });
      else out.valid_from = new Date(t).toISOString();
    }
  }
  if (has(payload, "valid_to")) {
    if (payload.valid_to === null || payload.valid_to === "") {
      out.valid_to = null;
    } else {
      const t = toTimestamp(payload.valid_to);
      if (t === null) errors.push({ field: "valid_to", message: "Data final inválida." });
      else out.valid_to = new Date(t).toISOString();
    }
  }
  const finalFrom = toTimestamp(out.valid_from ?? merged.valid_from);
  const finalTo = toTimestamp(out.valid_to ?? merged.valid_to);
  if (finalFrom !== null && finalTo !== null && finalFrom >= finalTo) {
    errors.push({ field: "valid_to", message: "O fim da validade deve ser posterior ao início." });
  }

  // Limite de usos (0 = ilimitado)
  if (has(payload, "max_uses") || !existing) {
    const maxUses = toInteger(payload.max_uses === undefined ? (merged.max_uses ?? 0) : payload.max_uses);
    if (maxUses === null) {
      errors.push({ field: "max_uses", message: "O limite de usos deve ser um número inteiro." });
    } else if (maxUses < 0) {
      errors.push({ field: "max_uses", message: "O limite de usos não pode ser negativo." });
    } else if (maxUses > 0 && maxUses < (toNumber(existing?.uses_count) || 0)) {
      errors.push({
        field: "max_uses",
        message: `O limite não pode ser menor que os usos já registrados (${toNumber(existing?.uses_count) || 0}).`,
      });
    } else out.max_uses = maxUses;
  }

  if (has(payload, "is_active")) {
    if (typeof payload.is_active !== "boolean") {
      errors.push({ field: "is_active", message: "is_active deve ser booleano." });
    } else out.is_active = payload.is_active;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: out };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------
export function validateCommerceRecord(entityName: string, payload: any, existing: any): ValidationResult {
  if (!isPlainObject(payload)) {
    return { ok: false, errors: [{ field: "_payload", message: "Dados inválidos." }] };
  }
  if (entityName === "TicketType") return validateTicketType(payload, existing);
  if (entityName === "SalesLot") return validateSalesLot(payload, existing);
  if (entityName === "Coupon") return validateCoupon(payload, existing);
  return { ok: false, errors: [{ field: "_entity", message: "Entidade não suportada." }] };
}

// ---------------------------------------------------------------------------
// Política de estorno do evento (Event.refund_policy como JSON)
// ---------------------------------------------------------------------------
const POLICY_KEYS = new Set([
  "full_refund_until_days",
  "partial_refund_percent",
  "no_refund_within_days",
  "allow_manual_override",
]);

export function validateRefundPolicyPayload(payload: any): ValidationResult {
  if (!isPlainObject(payload)) {
    return { ok: false, errors: [{ field: "_payload", message: "Política inválida." }] };
  }
  const errors: FieldError[] = [];
  const out: Record<string, any> = {};

  const unknown = Object.keys(payload).filter((k) => !POLICY_KEYS.has(k));
  if (unknown.length > 0) {
    errors.push({ field: unknown[0], message: "Campo desconhecido na política de estorno." });
  }

  if (has(payload, "full_refund_until_days")) {
    const n = toInteger(payload.full_refund_until_days);
    if (n === null || n < 0 || n > MAX_REFUND_DAYS) {
      errors.push({
        field: "full_refund_until_days",
        message: `Prazo de estorno integral deve ser um inteiro entre 0 e ${MAX_REFUND_DAYS} dias.`,
      });
    } else out.full_refund_until_days = n;
  }

  if (has(payload, "no_refund_within_days")) {
    const n = toInteger(payload.no_refund_within_days);
    if (n === null || n < 0 || n > MAX_REFUND_DAYS) {
      errors.push({
        field: "no_refund_within_days",
        message: `Prazo sem estorno deve ser um inteiro entre 0 e ${MAX_REFUND_DAYS} dias.`,
      });
    } else out.no_refund_within_days = n;
  }

  if (has(payload, "partial_refund_percent")) {
    const n = toNumber(payload.partial_refund_percent);
    if (n === null || n < 0 || n > 100) {
      errors.push({ field: "partial_refund_percent", message: "O percentual parcial deve estar entre 0 e 100." });
    } else out.partial_refund_percent = round2(n);
  }

  if (has(payload, "allow_manual_override")) {
    if (typeof payload.allow_manual_override !== "boolean") {
      errors.push({ field: "allow_manual_override", message: "allow_manual_override deve ser booleano." });
    } else out.allow_manual_override = payload.allow_manual_override;
  }

  // Coerência das janelas: o prazo de estorno integral precisa ser MAIOR que a
  // janela sem estorno — senão a faixa parcial desaparece e a política fica
  // contraditória. Compara o valor RESULTANTE (payload + padrão global).
  const full = out.full_refund_until_days ?? DEFAULT_GLOBAL_REFUND_POLICY.full_refund_until_days;
  const none = out.no_refund_within_days ?? DEFAULT_GLOBAL_REFUND_POLICY.no_refund_within_days;
  if (full <= none) {
    errors.push({
      field: "full_refund_until_days",
      message: "O prazo de estorno integral deve ser maior que o prazo sem estorno.",
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data: out };
}
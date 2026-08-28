// Commerce policy + cart calculation helpers (shared across backend functions).
//
// Refund policy: global default stored in app config (manageEventConfig entity "CommerceConfig"),
// overridable per event via RefundPolicy field on the event config record.
//
// Cart calc: pure functions for subtotal/discount/total given lots + coupon + items.
// Money is represented in BRL decimal (Stripe wants cents — conversion happens at the edge).

export const DEFAULT_GLOBAL_REFUND_POLICY = {
  full_refund_until_days: 7,        // estorno total até X dias antes do evento
  partial_refund_percent: 50,       // estorno parcial (%) após o prazo total
  no_refund_within_days: 1,         // sem estorno a partir de X dias antes do evento
  allow_manual_override: true,      // gerente pode aprovar manualmente fora da política
};

export type RefundPolicy = {
  full_refund_until_days?: number;
  partial_refund_percent?: number;
  no_refund_within_days?: number;
  allow_manual_override?: boolean;
};

// Resolve the effective refund policy: event override merges over global default.
export function resolveRefundPolicy(eventOverride: any, globalConfig: any): RefundPolicy {
  const global = (globalConfig && globalConfig.refund_policy) || {};
  const override = (eventOverride && eventOverride.refund_policy) || {};
  return {
    ...DEFAULT_GLOBAL_REFUND_POLICY,
    ...global,
    ...override,
  };
}

// Decide refund eligibility + amount for a full-order refund.
// eventStart: ISO date string of event start.
// now: current time (injectable for tests).
// paidAmount: total paid in BRL.
export function evaluateRefund(policy: RefundPolicy, eventStartISO: string, now: Date, paidAmount: number, isManual = false) {
  const result = { allowed: false, refundableAmount: 0, decision: 'no_refund', reason: '' };
  if (isManual && policy.allow_manual_override) {
    return { allowed: true, refundableAmount: paidAmount, decision: 'manual', reason: 'Estorno manual aprovado pelo gerente.' };
  }
  if (!eventStartISO) {
    return { allowed: true, refundableAmount: paidAmount, decision: 'manual', reason: 'Data do evento indefinida — estorno total permitido.' };
  }
  const eventStart = new Date(eventStartISO).getTime();
  const msUntil = eventStart - now.getTime();
  const daysUntil = msUntil / (1000 * 60 * 60 * 24);

  if (daysUntil > (policy.full_refund_until_days ?? 7)) {
    return { allowed: true, refundableAmount: paidAmount, decision: `full_${policy.full_refund_until_days}_days`, reason: `Estorno total: mais de ${policy.full_refund_until_days} dias antes do evento.` };
  }
  if (daysUntil > (policy.no_refund_within_days ?? 1)) {
    const pct = policy.partial_refund_percent ?? 0;
    const refundable = Math.round(paidAmount * (pct / 100) * 100) / 100;
    return { allowed: true, refundableAmount: refundable, decision: `partial_${pct}`, reason: `Estorno parcial (${pct}%): dentro da janela parcial.` };
  }
  return { allowed: false, refundableAmount: 0, decision: 'no_refund', reason: `Sem estorno: faltam menos de ${policy.no_refund_within_days} dias para o evento.` };
}

// ===== Cart calculation =====
export type CartLine = { lot_id: string; ticket_type_id: string; ticket_type_name: string; unit_price: number; holder_name: string; holder_email: string };

export type CartTotals = {
  subtotal: number;
  discount: number;
  total: number;
  coupon_valid: boolean;
  coupon_message: string;
};

// Apply coupon to cart. Returns totals + validity.
export function calculateCart(lines: CartLine[], coupon: any | null, now: Date): CartTotals {
  const subtotal = lines.reduce((s, l) => s + l.unit_price, 0);
  if (!coupon) {
    return { subtotal, discount: 0, total: subtotal, coupon_valid: false, coupon_message: '' };
  }
  // validity window
  if (coupon.valid_from && now < new Date(coupon.valid_from)) {
    return { subtotal, discount: 0, total: subtotal, coupon_valid: false, coupon_message: 'Cupom ainda não está disponível.' };
  }
  if (coupon.valid_to && now > new Date(coupon.valid_to)) {
    return { subtotal, discount: 0, total: subtotal, coupon_valid: false, coupon_message: 'Cupom expirado.' };
  }
  if (coupon.uses_count >= coupon.max_uses && coupon.max_uses > 0) {
    return { subtotal, discount: 0, total: subtotal, coupon_valid: false, coupon_message: 'Cupom esgotado.' };
  }
  if (!coupon.is_active || coupon.is_deleted) {
    return { subtotal, discount: 0, total: subtotal, coupon_valid: false, coupon_message: 'Cupom inválido.' };
  }
  let discount = 0;
  if (coupon.discount_type === 'percent') {
    discount = subtotal * (coupon.value / 100);
  } else {
    // fixed
    if (coupon.scope === 'per_ticket') {
      discount = coupon.value * lines.length;
    } else {
      discount = coupon.value;
    }
  }
  discount = Math.min(discount, subtotal);
  const total = Math.max(0, subtotal - discount);
  return { subtotal, discount: Math.round(discount * 100) / 100, total: Math.round(total * 100) / 100, coupon_valid: true, coupon_message: 'Cupom aplicado.' };
}

// BRL decimal -> cents (Stripe). Round to avoid float issues.
export function toCents(brl: number): number {
  return Math.round(brl * 100);
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

// Generate a short unique hash for ticket validation.
export function generateTicketHash(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segments = [8, 4, 4];
  return segments.map(len => {
    let s = '';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }).join('-');
}
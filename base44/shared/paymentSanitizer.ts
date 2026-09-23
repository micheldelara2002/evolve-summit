// Sanitização de Payment para respostas a gestores de evento (superfície
// não-admin): WHITELIST — só os campos de gestão saem. client_secret, intent_id
// e outros identificadores internos do Stripe nunca chegam ao cliente, nem por
// engano futuro (um campo novo no schema só aparece aqui se for adicionado
// explicitamente). NUNCA use blacklist nesta superfície.

const MANAGER_PAYMENT_FIELDS = [
  "id", "order_id", "event_id", "amount", "currency", "status", "provider",
  "payment_method", "refunded_amount", "fulfillment_status", "error_reason",
  "succeeded_at", "created_date",
];

export function sanitizePayment(p: any): any {
  if (!p) return null;
  const out: any = {};
  for (const f of MANAGER_PAYMENT_FIELDS) {
    if (p[f] !== undefined) out[f] = p[f];
  }
  // Visão de gestão que o organizador precisa por venda:
  // bruto − comissão da plataforma − taxa do Stripe = líquido.
  const applicationFee = Number(p.application_fee_amount || 0);
  const stripeFee = Number(p.stripe_fee_amount || 0);
  out.application_fee_amount = applicationFee;
  out.stripe_fee_amount = stripeFee;
  out.net_amount = Math.max(0, Number((Number(p.amount || 0) - applicationFee - stripeFee).toFixed(2)));
  return out;
}

export function sanitizePayments(payments: any[]): any[] {
  return (payments || []).map((p: any) => sanitizePayment(p)).filter(Boolean);
}
// P0 (2026-11-12) — Guardas PURAS do fluxo de estorno.
//
// Este módulo não importa nada (nem SDK, nem runtime) de propósito: as decisões
// de autorização/estado que protegem o dinheiro e os ingressos ficam testáveis
// isoladamente (tests/unit/refund-p0.test.mjs), e as funções backend usam
// EXATAMENTE estas funções — o teste cobre o código de produção, não uma cópia.
//
// Regras que este módulo centraliza:
//   - Origem confiável da RefundRequest (provenance gravada só pelo backend).
//   - Relações Payment ↔ Order ↔ RefundRequest (nunca cruzar pedido/evento).
//   - Propriedade da trava do ingresso (refund_request_id é o dono).
//   - Valor estornável (nunca acima do pago nem do saldo no Stripe).

// Marca de origem gravada EXCLUSIVAMENTE por requestRefund (service role).
// A criação direta via SDK é bloqueada por RLS (admin-only) e o reconciliador
// recusa qualquer solicitação sem esta marca — não existe caminho de usuário
// que consiga produzi-la.
export const REFUND_REQUEST_PROVENANCE = "request_refund_v1";

export type LockVerdict = "own" | "claimable" | "blocked" | "terminal";

export type LockOwnership = {
  ok: boolean;
  claimable: string[];
  owned: number;
  blocked: number;
  terminal: number;
  reason: string;
};

// Classificação do estado de UM ingresso em relação à solicitação que está
// executando a operação:
//   issued + sem dono            → claimable (pode ser travado por esta solicitação)
//   issued + com dono            → blocked   (dono inconsistente: nunca roubar)
//   refund_pending + nosso dono  → own       (a propriedade já é desta solicitação)
//   refund_pending + outro dono  → blocked   (pertence a outra solicitação)
//   refund_pending + sem dono    → blocked   (legado: exige recuperação admin)
//   used                         → blocked   (ingresso utilizado: dinheiro não volta)
//   cancelled / refunded         → terminal  (já consumido por operação anterior)
export function classifyTicketLock(ticket: any, refundRequestId?: string): LockVerdict {
  const status = String(ticket?.status || "");
  const owner = ticket?.refund_request_id == null ? "" : String(ticket.refund_request_id);
  if (status === "issued") return owner ? "blocked" : "claimable";
  if (status === "refund_pending") {
    if (!refundRequestId) return "blocked";
    return owner && owner === String(refundRequestId) ? "own" : "blocked";
  }
  if (status === "cancelled" || status === "refunded") return "terminal";
  return "blocked";
}

// Decide se esta solicitação pode (re)adquirir a propriedade das travas dos
// ingressos afetados. Sem refund_request_id não há operação: nada é liberado,
// nada é reivindicado (elimina o fallback genérico do P0.2).
export function evaluateLockOwnership(tickets: any[], refundRequestId?: string): LockOwnership {
  const out: LockOwnership = { ok: false, claimable: [], owned: 0, blocked: 0, terminal: 0, reason: "" };
  if (!refundRequestId) {
    out.reason = "refund_request_id obrigatório para travar/liberar ingressos.";
    return out;
  }
  for (const t of Array.isArray(tickets) ? tickets : []) {
    const verdict = classifyTicketLock(t, refundRequestId);
    if (verdict === "claimable") out.claimable.push(String(t.id));
    else if (verdict === "own") out.owned++;
    else if (verdict === "terminal") out.terminal++;
    else out.blocked++;
  }
  if (out.blocked > 0) {
    out.reason = "Existe ingresso afetado em estado incompatível com esta solicitação (utilizado ou travado por outra).";
    return out;
  }
  if (out.owned + out.claimable.length === 0) {
    out.reason = "Não há ingressos elegíveis sob esta solicitação.";
    return out;
  }
  out.ok = true;
  return out;
}

// Origem confiável: só o fluxo oficial de requestRefund produz esta marca.
export function isTrustedRefundRequest(req: any): boolean {
  if (!req) return false;
  if (req.provenance !== REFUND_REQUEST_PROVENANCE) return false;
  if (!req.idempotency_key) return false;
  return true;
}

// Relações que o servidor NUNCA aceita do cliente: pagamento do pedido certo,
// evento coerente nos três registros e solicitação amarrada ao pagamento.
export function validateRefundRelations(payment: any, order: any, request: any): { ok: boolean; reason: string } {
  if (!request) return { ok: false, reason: "Solicitação inexistente." };
  if (!payment) return { ok: false, reason: "Pagamento inexistente." };
  if (!order) return { ok: false, reason: "Pedido inexistente." };
  if (payment.order_id !== order.id) return { ok: false, reason: "Pagamento não pertence ao pedido da solicitação." };
  if (request.order_id !== order.id) return { ok: false, reason: "Solicitação não pertence ao pedido informado." };
  if (request.payment_id !== payment.id) return { ok: false, reason: "Solicitação não pertence ao pagamento informado." };
  if (order.event_id !== request.event_id) return { ok: false, reason: "Evento divergente entre pedido e solicitação." };
  if (payment.event_id && payment.event_id !== order.event_id) {
    return { ok: false, reason: "Evento divergente entre pagamento e pedido." };
  }
  return { ok: true, reason: "" };
}

// Valor: nunca acima do pago e do que o Stripe ainda não devolveu. O saldo é
// calculado sobre os estornos REAIS do Stripe (não sobre a reserva local), para
// que uma nova tentativa do reconciliador não seja bloqueada pela própria
// reserva de teto feita na solicitação original.
export function resolveRefundAmountCents(input: {
  requestAmountCents: number;
  paidCents: number;
  stripeRefundedCents: number;
}): { ok: boolean; cents: number; reason: string } {
  const amount = Math.round(Number(input.requestAmountCents) || 0);
  const paid = Math.round(Number(input.paidCents) || 0);
  const refunded = Math.round(Number(input.stripeRefundedCents) || 0);
  const remaining = Math.max(0, paid - refunded);
  if (amount <= 0) return { ok: false, cents: 0, reason: "Valor solicitado inválido." };
  if (paid <= 0) return { ok: false, cents: 0, reason: "Pagamento sem valor pago." };
  if (remaining <= 0) return { ok: false, cents: 0, reason: "Pagamento já totalmente estornado no Stripe." };
  if (amount > remaining) return { ok: false, cents: 0, reason: "Valor solicitado acima do saldo estornável no Stripe." };
  return { ok: true, cents: amount, reason: "" };
}
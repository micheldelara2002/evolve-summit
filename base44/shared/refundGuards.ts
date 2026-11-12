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

// ===== P0.1 (patch Fase 1) — CORRELAÇÃO INEQUÍVOCA Stripe Refund ↔ RefundRequest =====
//
// Identidade é SEMPRE um vínculo declarado, nunca uma coincidência de valor,
// data ou posição na lista:
//   1. `stripe_refund_id` gravado na solicitação (vínculo definitivo);
//   2. `metadata.refund_request_id` do próprio Refund no Stripe, gravada na
//      criação (createRefund) — sobrevive à perda da resposta HTTP.
// Valor e moeda são APENAS verificações adicionais. Sem identidade ⇒
// "inconclusive": nada é associado, nada é criado, o caso fica pendente.

export type RefundAssociationVerdict = "matched" | "absent" | "inconclusive";

export type RefundAssociation = {
  verdict: RefundAssociationVerdict;
  refund?: any;
  reason: string;
};

const refundMetaRequestId = (refund: any): string => {
  const v = refund?.metadata?.refund_request_id;
  return v == null ? "" : String(v);
};

const sameCurrency = (refund: any, currency?: string): boolean => {
  const a = String(refund?.currency || "").toLowerCase();
  const b = String(currency || "brl").toLowerCase();
  return !a || !b || a === b;
};

// P0.2 (patch final Fase 1) — DONO DE UM ESTORNO com os DOIS vínculos.
//
// Metadata do Refund e `stripe_refund_id` persistido são conferidos
// SIMULTANEAMENTE, considerando todas as solicitações do pagamento. Se ambos
// existirem e apontarem para solicitações diferentes, o resultado é CONFLITO —
// nunca se escolhe uma por prioridade, ordem ou conveniência.
type RefundOwnerResolution = { request: any | null; conflict: boolean; reason: string };

function resolveRefundOwner(refund: any, byId: Map<string, any>, requests: any[]): RefundOwnerResolution {
  const metaId = refundMetaRequestId(refund);
  const metaReq = metaId ? byId.get(metaId) || null : null;
  const storedOwners = requests.filter(
    (r: any) => r && r.stripe_refund_id && String(r.stripe_refund_id) === String(refund.id),
  );

  if (metaId && !metaReq) {
    return { request: null, conflict: true, reason: "Estorno declara solicitação inexistente neste pagamento." };
  }
  if (storedOwners.length > 1) {
    return { request: null, conflict: true, reason: "Estorno reivindicado por mais de uma solicitação." };
  }
  const storedReq = storedOwners[0] || null;
  if (metaReq && storedReq && String(metaReq.id) !== String(storedReq.id)) {
    return {
      request: null, conflict: true,
      reason: "Metadata e identificador gravado apontam para solicitações diferentes.",
    };
  }
  const owner = metaReq || storedReq;
  if (!owner) return { request: null, conflict: false, reason: "" };
  // Vínculo da própria solicitação, se existir, tem de ser ESTE estorno.
  if (owner.stripe_refund_id && String(owner.stripe_refund_id) !== String(refund.id)) {
    return { request: null, conflict: true, reason: "Solicitação vinculada a outro estorno." };
  }
  return { request: owner, conflict: false, reason: "" };
}

// Decide se ESTA solicitação tem (ou não) um Refund correspondente no Stripe.
// `complete` = false quando a listagem foi truncada (paginação incompleta):
// sem a lista inteira não é possível afirmar ausência — resultado inconclusivo.
// `siblingRequests` = demais solicitações do MESMO pagamento: entram na decisão
// para que um vínculo divergente entre elas seja detectado como conflito.
export function associateRefundToRequest(input: {
  refunds: any[];
  request: any;
  paymentIntentId: string;
  currency?: string;
  complete?: boolean;
  siblingRequests?: any[];
}): RefundAssociation {
  const request = input.request;
  if (!request?.id) return { verdict: "inconclusive", reason: "Solicitação sem identidade." };
  const intent = input.paymentIntentId == null ? "" : String(input.paymentIntentId);
  const complete = input.complete !== false;
  const all = Array.isArray(input.refunds) ? input.refunds.filter((r: any) => r && r.id) : [];
  // Estorno de outro PaymentIntent nunca é considerado (defesa extra: a lista
  // já vem filtrada por intent, mas o vínculo é conferido aqui também).
  const known = all.filter((r: any) => !r.payment_intent || !intent || String(r.payment_intent) === intent);

  // Pool de vínculos do pagamento: a solicitação em análise é sempre a fonte de
  // verdade do seu próprio estado (o snapshot passado pode estar defasado).
  const siblings = (Array.isArray(input.siblingRequests) ? input.siblingRequests : []).filter((r: any) => r && r.id);
  const byId = new Map<string, any>(siblings.map((r: any) => [String(r.id), r]));
  byId.set(String(request.id), request);
  const pool = [...byId.values()];

  const decide = (refund: any): RefundAssociation => {
    const owner = resolveRefundOwner(refund, byId, pool);
    if (owner.conflict) return { verdict: "inconclusive", reason: owner.reason };
    if (!owner.request || String(owner.request.id) !== String(request.id)) {
      return { verdict: "inconclusive", reason: "Estorno pertence a outra solicitação." };
    }
    if (refund.payment_intent && intent && String(refund.payment_intent) !== intent) {
      return { verdict: "inconclusive", reason: "Estorno pertence a outro PaymentIntent." };
    }
    if (!sameCurrency(refund, input.currency)) {
      return { verdict: "inconclusive", reason: "Estorno em moeda divergente do pagamento." };
    }
    return { verdict: "matched", refund, reason: "" };
  };

  // (1) Vínculo definitivo já gravado localmente.
  const storedId = request.stripe_refund_id ? String(request.stripe_refund_id) : "";
  if (storedId) {
    const byStored = known.find((r: any) => String(r.id) === storedId);
    if (byStored) return decide(byStored);
    // Gravado mas não encontrado: listagem incompleta/divergente ⇒ não decide
    // (nunca criar outro em cima de um resultado inconclusivo).
    return { verdict: "inconclusive", reason: "Estorno gravado não encontrado no Stripe." };
  }

  // (2) Identidade declarada pelo Stripe (metadata gravada na criação).
  const byMeta = known.filter((r: any) => refundMetaRequestId(r) === String(request.id));
  if (byMeta.length === 1) return decide(byMeta[0]);
  if (byMeta.length > 1) {
    return { verdict: "inconclusive", reason: "Mais de um estorno declara esta solicitação." };
  }

  // (3) Estorno sem NENHUM vínculo: proibido associar por valor.
  const unattributed = known.filter(
    (r: any) => !refundMetaRequestId(r)
      && !pool.some((x: any) => x.stripe_refund_id && String(x.stripe_refund_id) === String(r.id)),
  );
  if (unattributed.length > 0) {
    return { verdict: "inconclusive", reason: "Existe estorno no Stripe sem identidade de solicitação." };
  }

  if (!complete) return { verdict: "inconclusive", reason: "Listagem de estornos incompleta." };

  return { verdict: "absent", reason: "Nenhum estorno desta solicitação no Stripe." };
}

// Correlação usada pelo WEBHOOK (charge.refunded): descobre A QUAL solicitação
// pertencem os estornos do charge. Sem identidade única ⇒ matched = null.
//
// P1.1 (patch final Fase 1) — `complete: false` (lista truncada, `has_more=true`
// ou consulta que falhou) NUNCA produz associação: a única correspondência só
// pode ser afirmada sobre a lista INTEIRA. O webhook usa isso para não tocar
// ingressos/participantes/itens.
export function associateRefundsToRequests(input: {
  refunds: any[];
  requests: any[];
  paymentIntentId: string;
  currency?: string;
  complete?: boolean;
}): { matched: any | null; refund: any | null; reason: string; ambiguous: boolean; incomplete: boolean } {
  const requests = Array.isArray(input.requests) ? input.requests.filter((r: any) => r && r.id) : [];
  if (input.complete === false) {
    return {
      matched: null, refund: null,
      reason: "Listagem de estornos incompleta — associação não confirmada.",
      ambiguous: false, incomplete: true,
    };
  }
  if (requests.length === 0) {
    return { matched: null, refund: null, reason: "Pagamento sem solicitação de estorno.", ambiguous: false, incomplete: false };
  }
  const intent = input.paymentIntentId == null ? "" : String(input.paymentIntentId);
  const refunds = (Array.isArray(input.refunds) ? input.refunds : []).filter((r: any) => r && r.id)
    .filter((r: any) => !r.payment_intent || !intent || String(r.payment_intent) === intent);

  const byId = new Map<string, any>(requests.map((r: any) => [String(r.id), r]));
  const candidates = new Map<string, { request: any; refund: any }>();
  let conflict = "";
  for (const refund of refunds) {
    // P0.2 — metadata × `stripe_refund_id` das solicitações deste pagamento.
    const owner = resolveRefundOwner(refund, byId, requests);
    if (owner.conflict) {
      conflict = conflict || owner.reason;
      continue;
    }
    if (!owner.request) continue;
    if (!sameCurrency(refund, input.currency)) continue;
    if (!candidates.has(String(owner.request.id))) {
      candidates.set(String(owner.request.id), { request: owner.request, refund });
    }
  }

  // Conflito em QUALQUER estorno do pagamento impede a associação: escolher a
  // "melhor" candidata seria decidir por conveniência.
  if (conflict) {
    return { matched: null, refund: null, reason: conflict, ambiguous: true, incomplete: false };
  }
  if (candidates.size === 1) {
    const only = [...candidates.values()][0];
    return { matched: only.request, refund: only.refund, reason: "", ambiguous: false, incomplete: false };
  }
  if (candidates.size > 1) {
    return {
      matched: null, refund: null,
      reason: "Mais de uma solicitação corresponde a estornos deste pagamento.",
      ambiguous: true, incomplete: false,
    };
  }
  return { matched: null, refund: null, reason: "Nenhum estorno com identidade de solicitação.", ambiguous: false, incomplete: false };
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
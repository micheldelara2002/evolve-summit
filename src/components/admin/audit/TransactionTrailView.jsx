import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getTransactionTrail } from "@/lib/commerceApi";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, CreditCard, Undo2, CircleDollarSign } from "lucide-react";

// Visão de transações do painel de auditoria (admin): busca por pedido,
// pagamento, transação Stripe, estorno ou e-mail e mostra a linha do tempo
// completa daquela compra — criação com IP, pagamento, emissão, estornos.

const TYPE_LABELS = {
  compra_iniciada: "Compra iniciada (checkout)",
  checkout_reaberto: "Checkout reaberto — carrinho anterior invalidado",
  ticket_fulfillment: "Pagamento confirmado e ingressos emitidos",
  ticket_fulfillment_failed: "Falha na emissão de ingressos",
  ticket_refund: "Estorno processado",
  estorno_solicitado: "Estorno solicitado",
  refund_used_ticket_blocked: "Estorno atingiu ingresso já utilizado",
  refund_reconciled_offline: "Estorno confirmado pelo reconciler (webhook ausente)",
  stale_reservation_expired: "Pedido expirado (checkout abandonado)",
  stale_reservation_kept_paid: "Pedido pago mantido vivo (reserva vencida)",
};

const FIELD_LABELS = {
  valor: "Valor",
  valor_pago: "Valor pago",
  valor_total: "Total do pedido",
  valor_solicitado: "Valor solicitado",
  valor_estornado_acumulado: "Estornado (acumulado)",
  total_anterior: "Total anterior",
  intent_id: "Transação Stripe",
  stripe_refund_id: "Refund Stripe",
  payment_id: "Pagamento",
  refund_request_id: "Solicitação",
  tickets: "Ingressos emitidos",
  itens: "Itens",
  itens_invalidados: "Itens invalidados",
  partial: "Parcial",
  motivo: "Motivo",
  reason: "Motivo",
  error: "Erro",
  cupom: "Cupom",
  total: "Total",
  subtotal: "Subtotal",
  desconto: "Desconto",
  decisao_politica: "Decisão da política",
  tipo: "Tipo",
  gratuito: "Gratuito",
  payment_status: "Status do pagamento",
  fulfillment_status: "Status da emissão",
  comissao_plataforma: "Comissão da plataforma",
  destino_conta_stripe: "Conta destino (organizador)",
};

const MONEY_KEYS = new Set([
  "valor", "valor_pago", "valor_total", "valor_solicitado", "valor_estornado_acumulado",
  "total_anterior", "total", "subtotal", "desconto", "comissao_plataforma", "amount",
]);

const STATUS_LABELS = {
  pending: "Pendente",
  paid: "Pago",
  succeeded: "Pago",
  cancelled: "Cancelado",
  expired: "Expirado",
  failed: "Falhou",
  refunded: "Estornado",
  partially_refunded: "Parcialmente estornado",
  pending_retry: "Emissão pendente",
  fulfilled: "Emitido",
  processed: "Processado",
  approved: "Aprovado",
  rejected: "Rejeitado",
};

const STATUS_COLORS = {
  pending: "bg-amber-100 text-amber-700",
  pending_retry: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
  succeeded: "bg-emerald-100 text-emerald-700",
  fulfilled: "bg-emerald-100 text-emerald-700",
  processed: "bg-emerald-100 text-emerald-700",
  approved: "bg-sky-100 text-sky-700",
  cancelled: "bg-red-100 text-red-700",
  failed: "bg-red-100 text-red-700",
  rejected: "bg-red-100 text-red-700",
  expired: "bg-gray-200 text-gray-600",
  refunded: "bg-purple-100 text-purple-700",
  partially_refunded: "bg-purple-100 text-purple-700",
};

const REFUND_TYPE_LABELS = { full: "Integral", partial: "Parcial", cancel_item: "Por ingresso" };

const fmtBRL = (v) =>
  v == null || v === "" ? "—" : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString("pt-BR") : "—");

function StatusBadge({ status }) {
  return (
    <Badge variant="secondary" className={`text-[10px] whitespace-nowrap ${STATUS_COLORS[status] || ""}`}>
      {STATUS_LABELS[status] || status}
    </Badge>
  );
}

function parseDetails(details) {
  if (!details) return null;
  try {
    return typeof details === "string" ? JSON.parse(details) : details;
  } catch {
    return null;
  }
}

function detailEntries(d) {
  if (!d) return [];
  return Object.entries(d).filter(
    ([k, v]) => k !== "type" && v != null && v !== "" && typeof v !== "object"
  );
}

function fmtVal(key, value) {
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (MONEY_KEYS.has(key) && typeof value === "number") return fmtBRL(value);
  const s = String(value);
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}

export default function TransactionTrailView() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["transaction-trail", submitted],
    queryFn: () => getTransactionTrail(submitted),
    enabled: !!submitted,
  });

  const onSubmit = (e) => {
    e.preventDefault();
    const q = query.trim();
    if (q) setSubmitted(q);
  };

  const pickOrder = (orderId) => {
    setQuery(orderId);
    setSubmitted(orderId);
  };

  const trail = data?.trail || null;
  const matches = data?.matches || [];

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por pedido, pagamento, transação Stripe (pi_…), estorno (re_…) ou e-mail do comprador"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9 pr-24"
        />
        <Button
          type="submit"
          size="sm"
          className="absolute right-1 top-1/2 -translate-y-1/2"
          disabled={isLoading || !query.trim()}
        >
          {isLoading ? "Buscando…" : "Buscar"}
        </Button>
      </form>

      {isError && (
        <p className="text-sm text-destructive">Falha ao consultar a transação: {error?.message || "erro"}</p>
      )}

      {!submitted && !isLoading && (
        <p className="text-sm text-muted-foreground">
          Digite o identificador da transação (ou o e-mail do comprador) para ver a linha do tempo completa —
          criação com IP e carrinho, pagamento, emissão de ingressos, estornos e alertas.
        </p>
      )}

      {submitted && !isLoading && !isError && !trail && matches.length === 0 && (
        <p className="text-sm text-muted-foreground">Nenhuma transação encontrada para esta busca.</p>
      )}

      {submitted && !isLoading && !isError && !trail && matches.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Mais de um pedido encontrado para este comprador — selecione um:
          </p>
          {matches.map((m) => (
            <button
              key={m.order_id}
              type="button"
              onClick={() => pickOrder(m.order_id)}
              className="w-full text-left rounded-xl border border-border p-3 hover:bg-muted/40 transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium truncate">{m.buyer_name || m.buyer_email}</span>
                <StatusBadge status={m.status} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {fmtBRL(m.total)} · {fmtDateTime(m.created_date)} · <span className="font-mono">{m.order_id}</span>
              </p>
            </button>
          ))}
        </div>
      )}

      {data?.order && trail && (
        <>
          <div className="rounded-xl border border-border p-4 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-heading font-semibold truncate">{data.order.buyer_name || data.order.buyer_email}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {data.order.buyer_email} · {data.order.event_name || data.order.event_id}
                </p>
              </div>
              <StatusBadge status={data.order.status} />
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Total: <b className="text-foreground">{fmtBRL(data.order.total)}</b></span>
              <span>Subtotal: {fmtBRL(data.order.subtotal)}</span>
              <span>Desconto: {fmtBRL(data.order.discount)}</span>
              {data.order.coupon_code && <span>Cupom: {data.order.coupon_code}</span>}
              <span>Criado: {fmtDateTime(data.order.created_date)}</span>
              <span className="font-mono">{data.order.order_id}</span>
            </div>
            {data.order.error_reason && (
              <p className="text-xs text-destructive">{data.order.error_reason}</p>
            )}
          </div>

          {data.payments.map((p) => (
            <div key={p.id} className="rounded-xl border border-border p-4 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <CreditCard className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="font-mono text-xs truncate">{p.intent_id}</span>
                </div>
                <StatusBadge status={p.status} />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Pago: <b className="text-foreground">{fmtBRL(p.amount)}</b></span>
                {p.refunded_amount > 0 && <span>Estornado: {fmtBRL(p.refunded_amount)}</span>}
                {p.payment_method && <span>Método: {p.payment_method}</span>}
                {p.stripe_fee_amount > 0 && <span>Taxa Stripe: {fmtBRL(p.stripe_fee_amount)}</span>}
                {p.fulfillment_status && (
                  <span>Emissão: {STATUS_LABELS[p.fulfillment_status] || p.fulfillment_status}</span>
                )}
              </div>
              {p.error_reason && <p className="text-xs text-destructive">{p.error_reason}</p>}
            </div>
          ))}

          {data.refund_requests.length > 0 && (
            <div className="rounded-xl border border-border p-4 space-y-2">
              <p className="text-sm font-semibold flex items-center gap-2">
                <Undo2 className="w-4 h-4" /> Solicitações de estorno
              </p>
              {data.refund_requests.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <StatusBadge status={r.status} />
                  <span className="font-medium">{REFUND_TYPE_LABELS[r.refund_type] || r.refund_type}</span>
                  <span>Solicitado: {fmtBRL(r.amount_requested)}</span>
                  <span>Estornado: {fmtBRL(r.amount_refunded)}</span>
                  {r.requested_by_name && <span>Por: {r.requested_by_name}</span>}
                  {r.reason && <span className="text-muted-foreground">Motivo: {r.reason}</span>}
                  {r.stripe_refund_id && <span className="font-mono">{r.stripe_refund_id}</span>}
                  {r.rejection_reason && <span className="text-destructive">{r.rejection_reason}</span>}
                </div>
              ))}
            </div>
          )}

          <div className="rounded-xl border border-border p-4">
            <p className="text-sm font-semibold mb-3 flex items-center gap-2">
              <CircleDollarSign className="w-4 h-4" /> Linha do tempo da transação
            </p>
            {trail.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Nenhuma entrada de auditoria registrada para este pedido (compras anteriores à implementação do
                trail podem não ter eventos individuais).
              </p>
            )}
            {trail.map((e, i) => {
              const d = parseDetails(e.details);
              const label = (d?.type && (TYPE_LABELS[d.type] || d.type)) || STATUS_LABELS[e.action] || e.action;
              const entries = detailEntries(d);
              return (
                <div key={e.id} className={`relative pl-6 ${i < trail.length - 1 ? "pb-4" : ""}`}>
                  {i < trail.length - 1 && (
                    <div className="absolute left-[7px] top-4 bottom-0 w-px bg-border" />
                  )}
                  <div className="absolute left-0 top-1.5 w-4 h-4 rounded-full border-2 border-primary bg-background" />
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-sm font-medium">{label}</span>
                    <Badge variant="outline" className="text-[10px]">{e.action}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {fmtDateTime(e.created_date)} · {e.user_name || "Sistema"}
                    {e.ip_address ? ` · IP ${e.ip_address}` : ""}
                  </p>
                  {entries.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      {entries.map(([k, v]) => (
                        <span key={k} className="text-xs text-muted-foreground">
                          {FIELD_LABELS[k] || k}: <b className="text-foreground font-medium">{fmtVal(k, v)}</b>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
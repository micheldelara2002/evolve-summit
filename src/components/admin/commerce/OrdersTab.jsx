import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShoppingBag, ChevronDown, ChevronUp, RotateCcw, CheckCircle2, Clock, XCircle, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { getEventOrders, requestRefund, requestRefundItems } from "@/lib/commerceApi";

const ORDER_STATUS = {
  pending: { label: "Pendente", icon: Clock, cls: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
  paid: { label: "Pago", icon: CheckCircle2, cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
  cancelled: { label: "Cancelado", icon: XCircle, cls: "bg-muted text-muted-foreground border-border" },
  refunded: { label: "Estornado", icon: RotateCcw, cls: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
  partially_refunded: { label: "Estorno parcial", icon: RotateCcw, cls: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
};
const TICKET_STATUS = {
  issued: "Emitido",
  used: "Usado",
  cancelled: "Cancelado",
  refunded: "Estornado",
};

export default function OrdersTab({ eventId, user }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(null);
  const [refundTarget, setRefundTarget] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ["commerce", "orders", eventId],
    queryFn: () => getEventOrders(eventId),
  });
  const orders = data?.orders || [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["commerce", "orders", eventId] });
    qc.invalidateQueries({ queryKey: ["commerce", "payments", eventId] });
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold flex items-center gap-2"><ShoppingBag className="w-4 h-4 text-primary" /> Pedidos</h3>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : orders.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center bg-card rounded-xl border border-dashed border-border">
          Nenhum pedido ainda.
        </p>
      ) : (
        <div className="space-y-2">
          {orders.map((o) => {
            const isOpen = expanded === o.id;
            const meta = ORDER_STATUS[o.status] || ORDER_STATUS.pending;
            const Icon = meta.icon;
            const canRefund = o.payment_status === "succeeded" && (o.status === "paid" || o.status === "partially_refunded");
            return (
              <div key={o.id} className="rounded-xl bg-card border border-border overflow-hidden">
                <button
                  onClick={() => setExpanded(isOpen ? null : o.id)}
                  className="w-full flex items-center gap-3 p-3 text-left hover:bg-muted/30 transition-colors touch-manipulation select-none"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{o.buyer_name || "—"}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {new Date(o.created_date).toLocaleString("pt-BR")} · {o.items.length} ingresso(s)
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold">R$ {Number(o.total).toFixed(2)}</p>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${meta.cls}`}>
                      <Icon className="w-3 h-3" /> {meta.label}
                    </span>
                  </div>
                  {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
                </button>

                {isOpen && (
                  <div className="border-t border-border p-3 space-y-2 bg-muted/20">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>Comprador: {o.buyer_email || "—"}</span>
                      {o.coupon_code && <span>Cupom: {o.coupon_code}</span>}
                      <span>Pagamento: {o.payment_status || "—"}</span>
                      {o.payment_method && <span>Método: {o.payment_method}</span>}
                    </div>
                    <div className="space-y-1.5">
                      {o.items.map((it) => {
                        const refunded = it.refunded || it.ticket_status === "refunded" || it.ticket_status === "cancelled";
                        return (
                          <div key={it.id} className={`p-2.5 rounded-lg border ${refunded ? "border-border bg-muted/30 opacity-60" : "border-border bg-card"}`}>
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{it.holder_name}</p>
                                <p className="text-[11px] text-muted-foreground truncate">{it.ticket_type_name} · R$ {Number(it.unit_price).toFixed(2)}</p>
                                {it.holder_email && <p className="text-[10px] text-muted-foreground truncate">{it.holder_email}</p>}
                              </div>
                              <div className="text-right shrink-0">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${refunded ? "text-muted-foreground" : it.ticket_status === "used" ? "text-emerald-500" : "text-foreground"}`}>
                                  {refunded ? "Estornado" : TICKET_STATUS[it.ticket_status] || "—"}
                                </span>
                                {it.hash_code && <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{it.hash_code}</p>}
                              </div>
                            </div>
                            {it.ticket_status === "used" && it.used_at && (
                              <p className="text-[10px] text-emerald-500 mt-1 flex items-center gap-1"><QrCode className="w-3 h-3" /> Check-in {new Date(it.used_at).toLocaleString("pt-BR")}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {canRefund && (
                      <div className="pt-1">
                        <Button size="sm" variant="outline" onClick={() => setRefundTarget(o)}>
                          <RotateCcw className="w-3.5 h-3.5" /> Estornar
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {refundTarget && (
        <RefundModal order={refundTarget} user={user} onClose={() => setRefundTarget(null)} onSuccess={invalidate} toast={toast} />
      )}
    </div>
  );
}

function RefundModal({ order, user, onClose, onSuccess, toast }) {
  const [reason, setReason] = useState("");
  const [manualApprove, setManualApprove] = useState(false);
  const [selected, setSelected] = useState(() => new Set(order.items.filter((i) => !i.refunded).map((i) => i.id)));
  const [processing, setProcessing] = useState(false);

  const refundableItems = order.items.filter((i) => !i.refunded);
  const allSelected = refundableItems.length > 0 && refundableItems.every((i) => selected.has(i.id));
  const selectedCount = refundableItems.filter((i) => selected.has(i.id)).length;
  const refundAmount = refundableItems.filter((i) => selected.has(i.id)).reduce((s, i) => s + Number(i.unit_price || 0), 0);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleRefund = async () => {
    if (selectedCount === 0) return;
    setProcessing(true);
    try {
      if (allSelected) {
        const res = await requestRefund(order.payment_id, reason, "full", manualApprove);
        toast({ title: res.refund_status === "succeeded" ? "Estorno processado." : "Estorno solicitado.", description: res.reason });
      } else {
        const res = await requestRefundItems(order.payment_id, refundableItems.filter((i) => selected.has(i.id)).map((i) => i.id), reason, manualApprove);
        toast({ title: res.refund_status === "succeeded" ? "Estorno processado." : "Estorno solicitado.", description: `${res.cancelled_items} ingresso(s) estornado(s).` });
      }
      onSuccess();
      onClose();
    } catch (e) {
      toast({ title: "Erro no estorno", description: e.message, variant: "destructive" });
    }
    setProcessing(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-card rounded-2xl border border-border p-5 w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold">Estornar pedido</h3>
        <p className="text-sm text-muted-foreground">R$ {Number(order.total).toFixed(2)} · {order.buyer_name}</p>

        <div className="space-y-1.5">
          <p className="text-xs font-medium">Selecione os ingressos:</p>
          {refundableItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nenhum ingresso elegível para estorno.</p>
          ) : (
            refundableItems.map((it) => (
              <label key={it.id} className="flex items-center gap-2 p-2 rounded-lg border border-border cursor-pointer touch-manipulation select-none">
                <Switch checked={selected.has(it.id)} onCheckedChange={() => toggle(it.id)} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{it.holder_name}</p>
                  <p className="text-[10px] text-muted-foreground">{it.ticket_type_name} · R$ {Number(it.unit_price).toFixed(2)}</p>
                </div>
              </label>
            ))
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {allSelected ? "Estorno completo do pedido" : `Estorno de ${selectedCount} ingresso(s) — R$ ${refundAmount.toFixed(2)}`}
        </p>

        <div>
          <Label>Motivo (opcional)</Label>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo do estorno" />
        </div>
        {user?.role === "admin" && (
          <div className="flex items-center gap-2">
            <Switch checked={manualApprove} onCheckedChange={setManualApprove} id="manual2" />
            <Label htmlFor="manual2" className="cursor-pointer text-sm">Aprovar manualmente (ignora política)</Label>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancelar</Button>
          <Button className="flex-1" onClick={handleRefund} disabled={processing || selectedCount === 0}>
            {processing ? "Processando…" : "Confirmar estorno"}
          </Button>
        </div>
      </div>
    </div>
  );
}
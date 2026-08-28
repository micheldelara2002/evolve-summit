import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Receipt, RotateCcw, AlertCircle, CheckCircle2, Clock, XCircle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { requestRefund } from "@/lib/commerceApi";
import { useToast } from "@/components/ui/use-toast";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";

const STATUS_META = {
  pending: { label: "Pendente", icon: Clock, cls: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
  succeeded: { label: "Pago", icon: CheckCircle2, cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
  failed: { label: "Falhou", icon: XCircle, cls: "bg-destructive/10 text-destructive border-destructive/20" },
  expired: { label: "Expirado", icon: XCircle, cls: "bg-muted text-muted-foreground border-border" },
  refunded: { label: "Estornado", icon: RotateCcw, cls: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
  partially_refunded: { label: "Estorno parcial", icon: RotateCcw, cls: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
};

export default function TransactionsTab({ eventId, user }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [refundTarget, setRefundTarget] = useState(null);
  const [refundReason, setRefundReason] = useState("");
  const [manualApprove, setManualApprove] = useState(false);
  const [processing, setProcessing] = useState(false);

  const { data: payments = [], isLoading } = useQuery({
    queryKey: ["commerce", "payments", eventId],
    queryFn: () => base44.entities.Payment.filter({ event_id: eventId }),
  });

  const sorted = [...payments].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));

  const handleRefund = async () => {
    if (!refundTarget) return;
    setProcessing(true);
    try {
      const res = await requestRefund(refundTarget.id, refundReason, "full", manualApprove);
      toast({ title: res.refund_status === "succeeded" ? "Estorno processado." : "Estorno solicitado.", description: res.reason });
      setRefundTarget(null);
      setRefundReason("");
      setManualApprove(false);
      qc.invalidateQueries({ queryKey: ["commerce", "payments", eventId] });
    } catch (e) {
      toast({ title: "Erro no estorno", description: e.message, variant: "destructive" });
    }
    setProcessing(false);
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold flex items-center gap-2"><Receipt className="w-4 h-4 text-primary" /> Transações</h3>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center bg-card rounded-xl border border-dashed border-border">
          Nenhuma transação ainda.
        </p>
      ) : (
        <div className="space-y-2">
          {sorted.map((p) => {
            const meta = STATUS_META[p.status] || STATUS_META.pending;
            const Icon = meta.icon;
            const needsAttention = p.fulfillment_status === "pending_retry" || p.status === "failed";
            return (
              <div key={p.id} className={`p-3 rounded-xl bg-card border ${needsAttention ? "border-destructive/30" : "border-border"} space-y-2`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">R$ {Number(p.amount).toFixed(2)}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(p.created_date).toLocaleString("pt-BR")} · {p.payment_method || "—"}
                    </p>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${meta.cls}`}>
                    <Icon className="w-3 h-3" /> {meta.label}
                  </span>
                </div>
                {p.fulfillment_status === "pending_retry" && (
                  <div className="flex items-center gap-1.5 text-[11px] text-destructive">
                    <AlertCircle className="w-3.5 h-3.5" /> Fulfillment pendente — intervenção manual necessária
                  </div>
                )}
                {p.status === "succeeded" && (
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" variant="outline" onClick={() => { setRefundTarget(p); setManualApprove(false); }}>
                      <RotateCcw className="w-3.5 h-3.5" /> Estornar
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDeleteDialog
        open={!!refundTarget}
        onOpenChange={(v) => !v && setRefundTarget(null)}
        onConfirm={handleRefund}
        title="Confirmar estorno"
        description={refundTarget ? `Estorno de R$ ${Number(refundTarget.amount).toFixed(2)}. A política do evento será avaliada automaticamente.` : ""}
        confirmLabel={processing ? "Processando…" : "Estornar"}
      />
      {refundTarget && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-4" onClick={() => setRefundTarget(null)}>
          <div className="bg-card rounded-2xl border border-border p-5 w-full max-w-sm space-y-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold">Estornar transação</h3>
            <p className="text-sm text-muted-foreground">R$ {Number(refundTarget.amount).toFixed(2)} · {refundTarget.intent_id}</p>
            <div>
              <Label>Motivo (opcional)</Label>
              <Input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} placeholder="Motivo do estorno" />
            </div>
            {user?.role === "admin" && (
              <div className="flex items-center gap-2">
                <Switch checked={manualApprove} onCheckedChange={setManualApprove} id="manual" />
                <Label htmlFor="manual" className="cursor-pointer text-sm">Aprovar manualmente (ignora política)</Label>
              </div>
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setRefundTarget(null)}>Cancelar</Button>
              <Button className="flex-1" onClick={handleRefund} disabled={processing}>
                {processing ? "Processando…" : "Confirmar estorno"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
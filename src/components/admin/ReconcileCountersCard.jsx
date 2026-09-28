/**
 * P2 (auditoria 2026-09-28) — Reconciliação dos contadores de pontos/resgates.
 * points_total/redeemed_total são caches atômicos ($inc) e podem divergir do
 * ledger (PointTransaction/StoreRedemption) se um resgate for cancelado fora
 * do fluxo normal (ex.: manualmente). Este card roda o reconciler admin-only
 * reconcileParticipantCounters: primeiro em modo verificação (dry-run),
 * exibindo o drift encontrado, e então aplica a correção a partir do ledger.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { Scale, Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function ReconcileCountersCard({ eventId }) {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun) => {
    setBusy(true);
    try {
      const res = await base44.functions.invoke("reconcileParticipantCounters", { eventId, dryRun });
      setReport({ ...res.data, dryRun });
      if (!dryRun) toast.success("Contadores reconciliados com o ledger.");
    } catch (e) {
      toast.error(e?.message || "Falha na reconciliação.");
    } finally {
      setBusy(false);
    }
  };

  const drifted = report?.drifted || 0;

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3 flex flex-wrap items-center gap-3">
      <Scale className="w-4 h-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-[200px]">
        <p className="text-sm font-medium">Pontos e resgates</p>
        <p className="text-xs text-muted-foreground">
          Compara os contadores dos participantes com o ledger (lançamentos e resgates) e corrige divergências.
        </p>
        {report && (
          <p className="text-xs mt-1 text-muted-foreground">
            {report.reconciled} participante(s) verificado(s) ·{" "}
            {drifted > 0 ? (
              <span className="text-destructive font-medium">{drifted} com divergência</span>
            ) : (
              <span className="text-emerald-600 font-medium">sem divergências</span>
            )}
          </p>
        )}
      </div>
      <div className="flex gap-2 shrink-0">
        {report?.dryRun && drifted > 0 && (
          <Button size="sm" disabled={busy} onClick={() => run(false)}>Corrigir agora</Button>
        )}
        <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={() => run(true)}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          {report && !report.dryRun ? "Verificar de novo" : "Verificar divergências"}
        </Button>
      </div>
    </div>
  );
}
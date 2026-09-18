import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Landmark, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { refreshPayoutStatus, setPayoutReserve, startPayoutOnboarding } from "@/lib/payoutApi";

const STATUS = {
  pending: { label: "Verificação pendente", cls: "bg-amber-500/10 text-amber-500 border-amber-500/20", icon: ShieldAlert },
  verified: { label: "Conta verificada", cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20", icon: CheckCircle2 },
  restricted: { label: "Ação necessária", cls: "bg-red-500/10 text-red-500 border-red-500/20", icon: ShieldAlert },
  rejected: { label: "Conta rejeitada", cls: "bg-red-500/10 text-red-500 border-red-500/20", icon: ShieldAlert },
};

function fmtCnpj(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d.length === 14
    ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`
    : v;
}

// Status da conta conectada + pendências do Stripe + reserva para estornos.
export default function PayoutStatusCard({ eventId, account, commission, onChanged }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState("");
  const [reserve, setReserve] = useState("0");

  useEffect(() => {
    setReserve(String(account?.reserve_amount || 0));
  }, [account?.reserve_amount]);

  const meta = STATUS[account.status] || STATUS.pending;
  const Icon = meta.icon;
  const done = account.status === "verified";
  const pendingReqs = account.pending_requirements || [];

  const continueOnboarding = async () => {
    setBusy("link");
    try {
      const res = await startPayoutOnboarding(eventId, {});
      if (res?.url) window.open(res.url, "_blank");
    } catch (e) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
    setBusy("");
  };

  const refresh = async () => {
    setBusy("refresh");
    try {
      await refreshPayoutStatus(eventId);
      onChanged?.();
      toast({ title: "Status atualizado." });
    } catch (e) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
    setBusy("");
  };

  const saveReserve = async () => {
    setBusy("reserve");
    try {
      await setPayoutReserve(eventId, Number(String(reserve).replace(",", ".")) || 0);
      onChanged?.();
      toast({ title: "Reserva atualizada no Stripe." });
    } catch (e) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
    setBusy("");
  };

  return (
    <div className="space-y-5">
      <section className="p-5 rounded-xl bg-card border border-border space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate">{account.legal_name || "Conta do organizador"}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">CNPJ {fmtCnpj(account.legal_document_number)}</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border shrink-0 ${meta.cls}`}>
            <Icon className="w-3.5 h-3.5" /> {meta.label}
          </span>
        </div>

        {done ? (
          <p className="text-xs text-muted-foreground flex items-start gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
            As vendas caem direto no seu saldo Stripe. O Stripe repassa ao banco da sua empresa automaticamente e as taxas de processamento já saem do seu saldo.
          </p>
        ) : (
          <div className="space-y-3 rounded-lg bg-amber-500/5 border border-amber-500/20 p-3">
            <p className="text-xs">Para liberar o recebimento das vendas na sua conta, conclua a verificação no Stripe.</p>
            {pendingReqs.length > 0 && (
              <div>
                <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Pendências</p>
                <ul className="text-xs space-y-0.5 mt-1 list-disc list-inside">
                  {pendingReqs.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
            <Button size="sm" onClick={continueOnboarding} disabled={busy === "link"}>
              {busy === "link" ? "Abrindo…" : (<><ExternalLink className="w-3.5 h-3.5" /> Continuar verificação</>)}
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button size="sm" variant="outline" onClick={refresh} disabled={busy === "refresh"}>
            <RefreshCw className={`w-3.5 h-3.5 ${busy === "refresh" ? "animate-spin" : ""}`} /> Atualizar status
          </Button>
          {commission && (
            <p className="text-[11px] text-muted-foreground">
              Comissão da plataforma: {commission.effective}% por venda, retida automaticamente.
            </p>
          )}
        </div>
      </section>

      <section className="p-5 rounded-xl bg-card border border-border space-y-3">
        <div className="flex items-center gap-2">
          <Landmark className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold">Reserva para estornos</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Valor (R$) mantido retido pelo Stripe na sua conta para cobrir eventuais estornos após o repasse ao banco. Se um estorno exceder a reserva, o Stripe cobre e desconta automaticamente das suas próximas vendas.
        </p>
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <Label>Reserva mínima (R$)</Label>
            <Input type="number" min="0" value={reserve} onChange={(e) => setReserve(e.target.value)} disabled={!done} />
          </div>
          <Button size="sm" onClick={saveReserve} disabled={busy === "reserve" || !done}>
            {busy === "reserve" ? "Salvando…" : "Salvar"}
          </Button>
        </div>
      </section>
    </div>
  );
}
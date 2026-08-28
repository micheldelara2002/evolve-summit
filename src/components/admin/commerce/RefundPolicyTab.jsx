import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getRefundPolicy, setRefundPolicy, setRequiresPayment } from "@/lib/commerceApi";
import { useToast } from "@/components/ui/use-toast";

export default function RefundPolicyTab({ eventId, hasAccess, user }) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    full_refund_until_days: 7,
    partial_refund_percent: 50,
    no_refund_within_days: 1,
    allow_manual_override: true,
  });
  const [requiresPayment, setRequiresPaymentState] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [savingFlag, setSavingFlag] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["commerce", "refundPolicy", eventId],
    queryFn: () => getRefundPolicy(eventId),
  });

  useEffect(() => {
    if (data?.policy) setForm(data.policy);
    if (data !== undefined) setRequiresPaymentState(data.requires_payment || false);
  }, [data]);

  const savePolicy = async () => {
    setSavingPolicy(true);
    try {
      await setRefundPolicy(eventId, form);
      toast({ title: "Política de estorno salva." });
    } catch (e) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
    setSavingPolicy(false);
  };

  const toggleRequiresPayment = async (v) => {
    setRequiresPaymentState(v);
    setSavingFlag(true);
    try {
      await setRequiresPayment(eventId, v);
      toast({ title: v ? "Pagamento obrigatório ativado." : "Pagamento obrigatório desativado." });
    } catch (e) {
      setRequiresPaymentState(!v);
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
    setSavingFlag(false);
  };

  if (!hasAccess) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Sem permissão.</p>;
  }

  return (
    <div className="space-y-5">
      {/* Payment required flag */}
      <section className="p-4 rounded-xl bg-card border border-border space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Pagamento obrigatório</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Quando ativado, participantes precisam comprar ingressos para se inscrever no evento.
            </p>
          </div>
          <Switch checked={requiresPayment} onCheckedChange={toggleRequiresPayment} disabled={savingFlag} id="req-pay" />
        </div>
      </section>

      {/* Refund policy */}
      <section className="p-4 rounded-xl bg-card border border-border space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold">Política de Estorno</h3>
        </div>
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          Estes valores sobrepõem a política global padrão para este evento. O sistema calcula automaticamente a elegibilidade de estorno com base na data de início do evento.
        </p>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : (
          <div className="space-y-4">
            <div>
              <Label>Estorno total até (dias antes do evento)</Label>
              <Input type="number" min="0" value={form.full_refund_until_days} onChange={(e) => setForm({ ...form, full_refund_until_days: Number(e.target.value) })} />
              <p className="text-[11px] text-muted-foreground mt-1">Estorno integral se solicitado com mais de X dias de antecedência.</p>
            </div>
            <div>
              <Label>Estorno parcial (%)</Label>
              <Input type="number" min="0" max="100" value={form.partial_refund_percent} onChange={(e) => setForm({ ...form, partial_refund_percent: Number(e.target.value) })} />
              <p className="text-[11px] text-muted-foreground mt-1">Percentual reembolsado após o prazo de estorno total.</p>
            </div>
            <div>
              <Label>Sem estorno a partir de (dias antes do evento)</Label>
              <Input type="number" min="0" value={form.no_refund_within_days} onChange={(e) => setForm({ ...form, no_refund_within_days: Number(e.target.value) })} />
              <p className="text-[11px] text-muted-foreground mt-1">A partir de X dias antes, nenhum estorno é permitido.</p>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={form.allow_manual_override} onCheckedChange={(v) => setForm({ ...form, allow_manual_override: v })} id="manual-override" />
              <Label htmlFor="manual-override" className="cursor-pointer">Permitir estorno manual (gerente aprova fora da política)</Label>
            </div>

            <Button onClick={savePolicy} disabled={savingPolicy}>
              {savingPolicy ? "Salvando…" : "Salvar política"}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
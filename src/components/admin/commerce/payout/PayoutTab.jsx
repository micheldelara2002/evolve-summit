import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Percent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import RecipientCard from "./RecipientCard";
import { getAdminPayoutConfig, setEventCommission, setPlatformCommission } from "@/lib/payoutApi";

// Aba "Recebimento" (módulo Bilheteria, admin): comissão da plataforma
// (padrão + override por evento) e conta conectada que recebe as vendas.
export default function PayoutTab({ eventId }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["payout-admin", eventId],
    queryFn: () => getAdminPayoutConfig(eventId),
  });

  const [platformPct, setPlatformPct] = useState("");
  const [overridePct, setOverridePct] = useState("");

  useEffect(() => {
    if (data?.commission) {
      setPlatformPct(String(data.commission.platform_default));
      setOverridePct(data.commission.override != null ? String(data.commission.override) : "");
    }
  }, [data]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["payout-admin", eventId] });

  const savePlatform = async () => {
    try {
      await setPlatformCommission(Number(String(platformPct).replace(",", ".")) || 0);
      await invalidate();
      toast({ title: "Comissão padrão atualizada." });
    } catch (e) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
  };

  const saveOverride = async () => {
    const value = String(overridePct).trim() === "" ? null : Number(String(overridePct).replace(",", "."));
    try {
      await setEventCommission(eventId, value);
      await invalidate();
      toast({ title: value != null ? "Comissão do evento atualizada." : "Evento agora herda a comissão padrão." });
    } catch (e) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-5">
      <RecipientCard eventId={eventId} data={data} isLoading={isLoading} onChanged={invalidate} />

      <section className="p-4 rounded-xl bg-card border border-border space-y-4">
        <div className="flex items-center gap-2">
          <Percent className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold">Comissão da plataforma</h3>
        </div>
        <div>
          <Label>Padrão da plataforma (%)</Label>
          <div className="flex gap-2">
            <Input type="number" min="0" max="100" value={platformPct} onChange={(e) => setPlatformPct(e.target.value)} />
            <Button size="sm" onClick={savePlatform}>Salvar</Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            Percentual sobre o valor bruto do ingresso, retido automaticamente de cada venda. Aplica-se a todos os eventos sem override.
          </p>
        </div>
        <div>
          <Label>Comissão deste evento (%)</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              min="0"
              max="100"
              placeholder={data?.commission ? `Herdar padrão (${data.commission.platform_default}%)` : ""}
              value={overridePct}
              onChange={(e) => setOverridePct(e.target.value)}
            />
            <Button size="sm" variant="outline" onClick={saveOverride}>Salvar</Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            Vazio = herda o padrão da plataforma. Só se aplica a eventos vinculados a uma conta conectada do organizador.
          </p>
        </div>
      </section>
    </div>
  );
}
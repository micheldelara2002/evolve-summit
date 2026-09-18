import { useState } from "react";
import { Banknote, ExternalLink, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { startPayoutOnboarding } from "@/lib/payoutApi";

// Primeiro passo: organizador informa a empresa (pré-preenchível a partir dos
// dados já cadastrados) e é levado ao onboarding hospedado do Stripe (uma única vez).
export default function PayoutOnboardingCard({ eventId, onChanged }) {
  const { toast } = useToast();
  const [legalName, setLegalName] = useState("");
  const [docNumber, setDocNumber] = useState("");
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    try {
      const res = await startPayoutOnboarding(eventId, {
        legal_name: legalName.trim() || undefined,
        legal_document_number: docNumber.replace(/\D/g, "") || undefined,
      });
      if (res?.url) {
        window.open(res.url, "_blank");
        toast({ title: "Onboarding aberto no Stripe", description: "Conclua a verificação na janela que abriu e depois volte para cá." });
        onChanged?.();
      }
    } catch (e) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
    setStarting(false);
  };

  return (
    <section className="p-5 rounded-xl bg-card border border-border space-y-4">
      <div className="flex items-center gap-2">
        <Banknote className="w-5 h-5 text-primary" />
        <h3 className="text-sm font-semibold">Receba suas vendas direto na conta da sua empresa</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Conecte a conta bancária da empresa organizadora ao Stripe (de 2 a 5 minutos, apenas uma vez). O valor de cada venda cai direto na sua conta — a plataforma retém apenas a comissão, e o Stripe cuida de repasses e estornos automaticamente.
      </p>
      <div className="space-y-3">
        <div>
          <Label>Razão social</Label>
          <Input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Se ficar em branco, usamos os dados já cadastrados" />
        </div>
        <div>
          <Label>CNPJ</Label>
          <Input value={docNumber} onChange={(e) => setDocNumber(e.target.value)} placeholder="Somente números" inputMode="numeric" />
        </div>
      </div>
      <Button onClick={start} disabled={starting} className="w-full sm:w-auto">
        {starting ? "Abrindo…" : (<><ExternalLink className="w-4 h-4" /> Conectar conta no Stripe</>)}
      </Button>
      <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        As taxas de processamento do Stripe (cartão 3,99% + R$ 0,39 · Pix 1,19%) são descontadas do saldo da sua empresa — nada disso é cobrado da plataforma.
      </p>
    </section>
  );
}
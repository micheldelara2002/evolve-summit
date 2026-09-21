import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import { getEventPayout } from "@/lib/payoutApi";
import PayoutOnboardingCard from "./PayoutOnboardingCard";
import PayoutStatusCard from "./PayoutStatusCard";
import PayoutExportCard from "./PayoutExportCard";

// Painel "Receber minhas vendas" — organizador do evento conecta a conta
// Stripe da empresa, acompanha a verificação e exporta o relatório de vendas.
export default function PayoutPanel({ eventId, eventName }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ["payout", eventId],
    queryFn: () => getEventPayout(eventId),
  });

  // Retorno do onboarding do Stripe (?stripe_return=1) → re-verifica o status.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("stripe_return") === "1") {
      qc.invalidateQueries({ queryKey: ["payout", eventId] });
      toast({ title: "Verificando sua conta…", description: "Atualizamos o status após o retorno do Stripe." });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Carregando…</p>;
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ["payout", eventId] });

  return (
    <div className="space-y-5">
      {data?.account ? (
        <PayoutStatusCard
          eventId={eventId}
          account={data.account}
          commission={data.commission}
          rules={data.rules}
          onChanged={invalidate}
        />
      ) : (
        <PayoutOnboardingCard eventId={eventId} onChanged={invalidate} />
      )}
      <PayoutExportCard eventId={eventId} eventName={eventName} />
    </div>
  );
}
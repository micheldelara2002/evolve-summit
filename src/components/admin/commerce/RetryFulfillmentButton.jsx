import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retryFulfillment } from "@/lib/commerceApi";
import { useToast } from "@/components/ui/use-toast";

// P2 — Botão de retry de fulfillment para pagamentos em 'pending_retry'
// (pagos, com emissão de ingressos pendente). Usado na aba Transações
// (admin/gestor) e em Meus Ingressos (comprador).
export default function RetryFulfillmentButton({ paymentId, onDone }) {
  const { toast } = useToast();
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await retryFulfillment(paymentId);
      toast({
        title: res.fulfilled ? "Ingressos emitidos!" : "Emissão ainda pendente",
        description: res.fulfilled
          ? "Os ingressos foram emitidos e enviados por e-mail."
          : res.error || "Tente novamente em instantes.",
        variant: res.fulfilled ? undefined : "destructive",
      });
      if (onDone) onDone(res);
    } catch (e) {
      toast({ title: "Erro na retentativa", description: e.message, variant: "destructive" });
    }
    setRetrying(false);
  };

  return (
    <Button size="sm" variant="outline" onClick={handleRetry} disabled={retrying}>
      <RefreshCw className={`w-3.5 h-3.5 ${retrying ? "animate-spin" : ""}`} />
      {retrying ? "Tentando…" : "Tentar novamente"}
    </Button>
  );
}
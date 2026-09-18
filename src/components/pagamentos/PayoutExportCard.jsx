import { useState } from "react";
import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { getEventOrders } from "@/lib/commerceApi";
import { downloadSalesCsv } from "@/lib/salesExport";

// Exportação do relatório de vendas (CSV) para emissão de NFs em lote no
// emissor do próprio organizador.
export default function PayoutExportCard({ eventId, eventName }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const exportCsv = async () => {
    setBusy(true);
    try {
      const res = await getEventOrders(eventId);
      const orders = res?.orders || [];
      downloadSalesCsv(eventName || eventId, orders);
      const paid = orders.filter((o) => o.status === "paid" || o.status === "partially_refunded").length;
      toast({ title: "Relatório gerado.", description: `${paid} venda(s) no CSV.` });
    } catch (e) {
      toast({ title: "Erro", description: e.message, variant: "destructive" });
    }
    setBusy(false);
  };

  return (
    <section className="p-5 rounded-xl bg-card border border-border space-y-3">
      <div className="flex items-center gap-2">
        <FileText className="w-5 h-5 text-primary" />
        <h3 className="text-sm font-semibold">Relatório de vendas (CSV)</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Exporte as vendas pagas do evento para emitir as notas fiscais em lote no emissor da sua empresa — a NF sempre sai no CNPJ do organizador.
      </p>
      <Button size="sm" variant="outline" onClick={exportCsv} disabled={busy}>
        <Download className="w-3.5 h-3.5" /> {busy ? "Gerando…" : "Exportar CSV"}
      </Button>
    </section>
  );
}
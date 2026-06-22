/**
 * Exibe o QR Code do parceiro para o evento selecionado.
 * O QR é único por partner+evento — codifica uma URL de scan.
 */
import { QrCode, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export default function PartnerQRTab({ eventId, partnerId, partner, event }) {
  const scanUrl = `${window.location.origin}/evento/${eventId}?partner_scan=${partnerId}`;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=${encodeURIComponent(scanUrl)}`;

  const copyUrl = () => {
    navigator.clipboard.writeText(scanUrl);
    toast.success("Link copiado.");
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-display font-semibold flex items-center gap-2">
          <QrCode className="w-4 h-4 text-orange-600" /> QR Code do Parceiro
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Exiba este QR no estande. Participantes que escanearem serão registrados como leads.
        </p>
      </div>

      <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-6">
        <div className="text-center">
          <p className="text-sm font-medium">{partner?.trade_name || "Parceiro"}</p>
          <p className="text-xs text-muted-foreground">{event?.name || "Evento"}</p>
        </div>

        <div className="w-64 h-64 rounded-2xl border-2 border-border bg-white p-3 flex items-center justify-center">
          <img src={qrImageUrl} alt="QR Code do parceiro" className="w-full h-full object-contain" />
        </div>

        <div className="w-full max-w-sm space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
            <span className="text-xs text-muted-foreground truncate flex-1">{scanUrl}</span>
            <Button variant="ghost" size="icon" className="w-7 h-7 shrink-0" onClick={copyUrl}>
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
          <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => window.open(scanUrl, "_blank")}>
            <ExternalLink className="w-3.5 h-3.5" /> Abrir link de scan
          </Button>
        </div>
      </div>
    </div>
  );
}
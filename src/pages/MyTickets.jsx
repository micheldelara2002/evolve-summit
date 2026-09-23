import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Ticket, Calendar, QrCode, MapPin, Download, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getMyOrders, getTicketPdf } from "@/lib/commerceApi";
import RetryFulfillmentButton from "@/components/admin/commerce/RetryFulfillmentButton";
import { useToast } from "@/components/ui/use-toast";

const STATUS_LABEL = {
  pending: "Pendente",
  paid: "Pago",
  cancelled: "Cancelado",
  refunded: "Estornado",
  partially_refunded: "Estorno parcial",
};

export default function MyTickets() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["my-orders"],
    queryFn: () => getMyOrders(),
  });

  const orders = data?.orders || [];

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}><ArrowLeft className="w-5 h-5" /></Button>
        <h1 className="text-xl font-display font-bold flex items-center gap-2"><Ticket className="w-5 h-5 text-primary" /> Meus Ingressos</h1>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-20"><div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
      ) : orders.length === 0 ? (
        <div className="text-center py-20 space-y-3">
          <Ticket className="w-12 h-12 text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">Você ainda não comprou ingressos.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {orders.map((order) => {
            const event = order.event;
            const eventDate = event?.start_date ? new Date(event.start_date).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : null;
            return (
              <div key={order.id} className="rounded-2xl bg-card border border-border overflow-hidden">
                <div className="p-4 border-b border-border bg-muted/30">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                      {STATUS_LABEL[order.status] || order.status}
                    </span>
                    <span className="text-xs text-muted-foreground">{new Date(order.created_date).toLocaleDateString("pt-BR")}</span>
                  </div>
                  {event && (
                    <div className="mt-2">
                      <p className="font-display font-bold text-base leading-tight">{event.name}</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
                        {eventDate && <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> {eventDate}</span>}
                        {event.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {event.location}</span>}
                      </div>
                    </div>
                  )}
                  <p className="font-display font-bold text-lg mt-1.5">R$ {Number(order.total).toFixed(2)}</p>
                  {order.coupon_code && <p className="text-[11px] text-emerald-500">Cupom: {order.coupon_code}</p>}
                </div>
                <div className="divide-y divide-border">
                  {order.tickets.map((ticket) => (
                    <TicketRow key={ticket.id} ticket={ticket} eventId={order.event_id} />
                  ))}
                  {order.tickets.length === 0 && order.status === "pending" && (
                    <div className="p-4 text-sm text-muted-foreground">Pagamento em processamento…</div>
                  )}
                </div>
                {order.payment?.fulfillment_status === "pending_retry" && (
                  <div className="p-4 flex items-center justify-between gap-3 bg-destructive/5 border-t border-border">
                    <p className="text-xs text-destructive flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" /> Pagamento confirmado — emissão dos ingressos pendente
                    </p>
                    <RetryFulfillmentButton
                      paymentId={order.payment.id}
                      onDone={() => qc.invalidateQueries({ queryKey: ["my-orders"] })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TicketRow({ ticket, eventId }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(ticket.hash_code)}`;
  const cancelled = ticket.status === "cancelled" || ticket.status === "refunded";

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      const res = await getTicketPdf(ticket.id);
      // Ingresso legado com link armazenado — abre direto.
      if (res?.file_url) {
        window.open(res.file_url, "_blank");
      } else if (res?.file_base64) {
        // PDF gerado sob demanda — decodifica e dispara o download.
        const bin = atob(res.file_base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = res.filename || `ingresso-${ticket.hash_code}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        throw new Error("PDF indisponível.");
      }
    } catch (e) {
      toast({ title: "Erro ao baixar ingresso", description: e.message, variant: "destructive" });
    }
    setDownloading(false);
  };
  return (
    <div className="p-4 flex items-center gap-4">
      <div className="shrink-0">
        {cancelled ? (
          <div className="w-20 h-20 rounded-lg bg-muted flex items-center justify-center">
            <span className="text-[10px] text-muted-foreground text-center px-1">Ingresso cancelado</span>
          </div>
        ) : (
          <img src={qrUrl} alt="QR do ingresso" className="w-20 h-20 rounded-lg" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{ticket.holder_name}</p>
        <p className="text-xs text-muted-foreground">{ticket.ticket_type_name}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">Código: {ticket.hash_code}</p>
      </div>
      {!cancelled && (
        <div className="flex flex-col gap-1.5 shrink-0">
          <Button size="sm" variant="outline" onClick={() => navigate(`/event/${eventId}`)}>
            <Calendar className="w-3.5 h-3.5 mr-1" /> Entrar
          </Button>
          <Button size="sm" variant="outline" onClick={downloadPdf} disabled={downloading}>
            <Download className="w-3.5 h-3.5 mr-1" /> {downloading ? "Gerando…" : "PDF"}
          </Button>
        </div>
      )}
    </div>
  );
}
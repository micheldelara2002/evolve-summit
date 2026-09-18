import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Banknote } from "lucide-react";
import { Button } from "@/components/ui/button";
import EmptyState from "@/components/ui/EmptyState";
import PayoutPanel from "@/components/pagamentos/PayoutPanel";
import { useEventAccess } from "@/hooks/useEventAccess";

// "Receber minhas vendas" — painel do organizador do evento (gerente/equipe
// com membership, ou admin). O organizador conecta a conta Stripe da empresa,
// acompanha a verificação, ajusta a reserva para estornos e exporta vendas.
export default function EventPayout() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const { event, hasAccess, loading } = useEventAccess(eventId);

  return (
    <div className="space-y-5 max-w-2xl mx-auto">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate("/my-events")} className="shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-lg font-display font-bold flex items-center gap-2">
            <Banknote className="w-5 h-5 text-primary shrink-0" /> Receber minhas vendas
          </h1>
          <p className="text-xs text-muted-foreground truncate">{event?.name || ""}</p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !hasAccess ? (
        <EmptyState
          icon={Banknote}
          title="Sem permissão"
          description="Apenas o gerente ou a equipe do evento acessa o recebimento de vendas."
        />
      ) : (
        <PayoutPanel eventId={eventId} eventName={event?.name} />
      )}
    </div>
  );
}
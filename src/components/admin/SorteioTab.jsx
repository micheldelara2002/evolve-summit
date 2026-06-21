/**
 * Aba de Sorteio no painel administrativo do evento.
 * Contexto: organizer — acesso a todos os participantes do evento.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Trophy } from "lucide-react";
import RaffleModal from "@/components/raffle/RaffleModal";
import RaffleHistory from "@/components/raffle/RaffleHistory";

export default function SorteioTab({ eventId, user }) {
  const [modalOpen, setModalOpen] = useState(false);

  const { data: participants = [] } = useQuery({
    queryKey: ["participants", eventId],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", eventId],
    queryFn: () => base44.entities.Session.filter({ event_id: eventId, is_deleted: false }),
  });

  // Pool: todos os participantes confirmados/registrados
  const eligiblePool = participants
    .filter((p) => p.registration_status !== "cancelled")
    .map((p) => ({ id: p.id, full_name: p.full_name, email: p.email, company: p.company }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-display font-semibold flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-500" /> Sorteios do Evento
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {eligiblePool.length} participante{eligiblePool.length !== 1 ? "s" : ""} elegíveis
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)} className="gap-2">
          <Trophy className="w-4 h-4" /> Novo Sorteio
        </Button>
      </div>

      <RaffleHistory eventId={eventId} />

      <RaffleModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        eventId={eventId}
        context="organizer"
        drawnByLabel={user?.full_name || "Organizador"}
        eligiblePool={eligiblePool}
        sessions={sessions}
        user={user}
      />
    </div>
  );
}
/**
 * Sorteio no contexto do parceiro.
 * Público elegível = leads do parceiro no evento.
 * Reusa RaffleModal + RaffleHistory.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Trophy, Lock } from "lucide-react";
import RaffleModal from "@/components/raffle/RaffleModal";
import RaffleHistory from "@/components/raffle/RaffleHistory";

export default function PartnerRaffleSection({ eventId, partnerId, user, isReadOnly, drawnByLabel }) {
  const [modalOpen, setModalOpen] = useState(false);

  const { data: leads = [] } = useQuery({
    queryKey: ["partner_raffle_leads", eventId, partnerId],
    queryFn: () => base44.entities.Lead.filter({ event_id: eventId, partner_id: partnerId }),
    enabled: !!eventId && !!partnerId,
  });

  // Pool elegível = leads (únicos por participant_id)
  const seen = new Set();
  const eligiblePool = leads
    .filter((l) => {
      const key = l.participant_id || l.participant_email;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((l) => ({ id: l.participant_id || l.id, full_name: l.participant_name, email: l.participant_email }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-display font-semibold flex items-center gap-2">
            <Trophy className="w-4 h-4 text-amber-500" /> Sorteio do Parceiro
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {eligiblePool.length} lead(s) elegíve{eligiblePool.length !== 1 ? "is" : "l"} no evento
          </p>
        </div>
        {!isReadOnly && (
          <Button onClick={() => setModalOpen(true)} className="gap-2" disabled={eligiblePool.length === 0}>
            <Trophy className="w-4 h-4" /> Novo Sorteio
          </Button>
        )}
      </div>

      {isReadOnly && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm">
          <Lock className="w-4 h-4 shrink-0" /> Evento encerrado — sorteios indisponíveis em modo consulta.
        </div>
      )}

      <RaffleHistory eventId={eventId} />

      {!isReadOnly && (
        <RaffleModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          eventId={eventId}
          context="partner"
          contextRefId={partnerId}
          drawnByLabel={drawnByLabel || "Parceiro"}
          eligiblePool={eligiblePool}
          user={user}
        />
      )}
    </div>
  );
}
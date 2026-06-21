/**
 * Seção de sorteio dentro do card de evento do palestrante.
 * Pool: participantes com presença registrada nas sessões do speaker.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Ticket, Trophy } from "lucide-react";
import RaffleModal from "@/components/raffle/RaffleModal";
import RaffleHistory from "@/components/raffle/RaffleHistory";

export default function SpeakerRaffleSection({ event, myParticipant, user }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Sessões do speaker neste evento
  const { data: sessions = [] } = useQuery({
    queryKey: ["speaker-raffle-sessions", event.id, myParticipant?.id],
    queryFn: () => base44.entities.Session.filter({ event_id: event.id, is_deleted: false }),
    select: (all) => all.filter((s) => s.speaker_id === myParticipant?.id),
    enabled: !!myParticipant?.id,
  });

  const sessionIds = sessions.map((s) => s.id);

  // Presenças nas sessões do speaker
  const { data: attendances = [] } = useQuery({
    queryKey: ["speaker-raffle-attendances", sessionIds.join(",")],
    queryFn: async () => {
      if (!sessionIds.length) return [];
      const all = await base44.entities.SessionAttendance.filter({ event_id: event.id, is_present: true });
      return all.filter((a) => sessionIds.includes(a.session_id));
    },
    enabled: sessionIds.length > 0,
  });

  // Resolve participant records únicos
  const participantIds = [...new Set(attendances.map((a) => a.participant_id))];

  const { data: participants = [] } = useQuery({
    queryKey: ["speaker-raffle-participants", participantIds.join(",")],
    queryFn: async () => {
      if (!participantIds.length) return [];
      const all = await base44.entities.Participant.filter({ event_id: event.id, is_deleted: false });
      return all.filter((p) => participantIds.includes(p.id));
    },
    enabled: participantIds.length > 0,
  });

  const eligiblePool = participants.map((p) => ({
    id: p.id,
    full_name: p.full_name,
    email: p.email,
    company: p.company,
  }));

  return (
    <div className="px-4 py-3 border-t border-border bg-muted/10 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Ticket className="w-4 h-4 text-amber-500" />
          <span className="text-sm font-semibold">Sorteio</span>
          <span className="text-xs text-muted-foreground">· {eligiblePool.length} elegível{eligiblePool.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? "Ocultar histórico" : "Histórico"}
          </Button>
          <Button size="sm" className="gap-1.5" onClick={() => setModalOpen(true)}>
            <Trophy className="w-3.5 h-3.5" /> Sortear
          </Button>
        </div>
      </div>

      {showHistory && <RaffleHistory eventId={event.id} />}

      <RaffleModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        eventId={event.id}
        context="speaker"
        contextRefId={myParticipant?.id}
        drawnByLabel={myParticipant?.full_name || user?.full_name || "Palestrante"}
        eligiblePool={eligiblePool}
        sessions={sessions}
        user={user}
      />
    </div>
  );
}
/**
 * Painel do Palestrante — escopo por person (usuário), segregado por evento.
 * KPIs consolidados + gestão de palestras por evento.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Mic } from "lucide-react";
import SpeakerKPIs from "@/components/palestrante/SpeakerKPIs";
import SpeakerEventCard from "@/components/palestrante/SpeakerEventCard";
import SpeakerRankingView from "@/components/palestrante/SpeakerRankingView";

export default function PainelPalestrante() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [selectedEventId, setSelectedEventId] = useState(null);

  // Resolve person do usuário
  const { data: myPerson } = useQuery({
    queryKey: ["my_person_speaker", user?.person_id],
    queryFn: async () => {
      if (!user?.person_id) return null;
      const list = await base44.entities.Person.filter({ id: user.person_id });
      return list[0] ?? null;
    },
    enabled: !!user?.person_id,
  });

  // Participações como speaker
  const { data: speakerParticipants = [], isLoading } = useQuery({
    queryKey: ["speaker-participants", user?.person_id, user?.email],
    queryFn: async () => {
      const all = await base44.entities.Participant.filter({ is_deleted: false });
      return all.filter(
        (p) =>
          p.role_in_event === "speaker" &&
          (p.person_id === user?.person_id || p.email === user?.email)
      );
    },
    enabled: !!user,
  });

  const eventIds = [...new Set(speakerParticipants.map((p) => p.event_id))];

  const { data: events = [] } = useQuery({
    queryKey: ["speaker-events", eventIds.join(",")],
    queryFn: async () => {
      if (!eventIds.length) return [];
      const all = await base44.entities.Event.filter({ is_deleted: false });
      return all.filter((e) => eventIds.includes(e.id));
    },
    enabled: eventIds.length > 0,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!speakerParticipants.length) {
    return (
      <div className="text-center py-24 space-y-3 max-w-sm mx-auto">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
          <Mic className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-display font-bold">Nenhuma palestra encontrada</h2>
        <p className="text-sm text-muted-foreground">Você ainda não está cadastrado como palestrante em nenhum evento.</p>
        <Button variant="outline" onClick={() => navigate("/")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Voltar
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")} className="-ml-2">
          <ArrowLeft className="w-4 h-4 mr-1" /> Voltar
        </Button>
        <div>
          <h1 className="text-2xl font-display font-bold flex items-center gap-2">
            <Mic className="w-6 h-6 text-primary" /> Painel do Palestrante
          </h1>
          <p className="text-sm text-muted-foreground">{myPerson?.full_name || user?.full_name}</p>
        </div>
      </div>

      {/* KPIs consolidados */}
      <SpeakerKPIs
        speakerParticipants={speakerParticipants}
        events={events}
        personId={user?.person_id}
        userEmail={user?.email}
      />

      {/* Ranking de avaliações */}
      <SpeakerRankingView speakerParticipants={speakerParticipants} />

      {/* Por evento */}
      <div className="space-y-4">
        <h2 className="text-base font-display font-semibold">Minhas Palestras por Evento</h2>
        {events.map((event) => {
          const myParticipantInEvent = speakerParticipants.find((p) => p.event_id === event.id);
          return (
            <SpeakerEventCard
              key={event.id}
              event={event}
              myParticipant={myParticipantInEvent}
              personId={user?.person_id}
              userEmail={user?.email}
              user={user}
            />
          );
        })}
      </div>
    </div>
  );
}
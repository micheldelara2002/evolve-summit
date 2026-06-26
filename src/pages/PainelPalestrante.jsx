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
import TopAppBar from "@/components/layout/TopAppBar";
import EmptyState from "@/components/ui/EmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";

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
    return <ListSkeleton count={3} />;
  }

  if (!speakerParticipants.length) {
    return (
      <EmptyState
        icon={Mic}
        title="Nenhuma palestra encontrada"
        description="Você ainda não está cadastrado como palestrante em nenhum evento."
        action={<Button variant="outline" onClick={() => navigate("/")}>Voltar</Button>}
      />
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <TopAppBar
        title="Painel do Palestrante"
        subtitle={myPerson?.full_name || user?.full_name}
        onBack={() => navigate("/")}
      />

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
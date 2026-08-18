/**
 * Painel do Palestrante — escopo por person (usuário), segregado por evento.
 * KPIs consolidados + gestão de palestras por evento.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Mic } from "lucide-react";
import SpeakerKPIs from "@/components/palestrante/SpeakerKPIs";
import SpeakerEventCard from "@/components/palestrante/SpeakerEventCard";
import SpeakerRankingView from "@/components/palestrante/SpeakerRankingView";
import SubmissionsSection from "@/components/palestrante/SubmissionsSection";
import PageHeader from "@/components/layout/PageHeader";
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

  // Participações como speaker — scoped por email e person_id
  const { data: speakerParticipants = [], isLoading } = useQuery({
    queryKey: ["speaker-participants", user?.person_id, user?.email],
    queryFn: async () => {
      const queries = [
        base44.entities.Participant.filter({ email: user?.email, is_deleted: false }),
      ];
      if (user?.person_id) {
        queries.push(base44.entities.Participant.filter({ person_id: user.person_id, is_deleted: false }));
      }
      const [byEmail, byPersonId] = await Promise.all(queries);
      const merged = [...byEmail, ...(byPersonId || [])];
      const seen = new Set();
      return merged.filter((p) => {
        if (seen.has(p.id)) return false;
        if (p.role_in_event !== "speaker") return false;
        seen.add(p.id);
        return true;
      });
    },
    enabled: !!user,
  });

  const eventIds = [...new Set(speakerParticipants.map((p) => p.event_id))];

  const { data: events = [] } = useQuery({
    queryKey: ["speaker-events", eventIds.join(",")],
    queryFn: async () => {
      if (!eventIds.length) return [];
      return base44.entities.Event.filter({ id: { $in: eventIds }, is_deleted: false });
    },
    enabled: eventIds.length > 0,
  });

  // Submissões da pessoa (em todos os eventos) — visível mesmo antes de virar palestrante
  const { data: mySubmissions = [] } = useQuery({
    queryKey: ["my-submissions", user?.person_id],
    queryFn: async () => {
      if (!user?.person_id) return [];
      return base44.entities.Submission.filter({ person_id: user.person_id, is_deleted: false });
    },
    enabled: !!user?.person_id,
  });

  if (isLoading) {
    return <ListSkeleton count={3} />;
  }

  const hasSubmissions = mySubmissions.length > 0;
  const isSpeaker = speakerParticipants.length > 0;

  if (!isSpeaker && !hasSubmissions) {
    return (
      <EmptyState
        icon={Mic}
        title="Nenhuma palestra encontrada"
        description="Você ainda não submeteu nem é palestrante em nenhum evento."
        action={<Button variant="outline" onClick={() => navigate("/cfp")}>Ver chamadas abertas</Button>}
      />
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader icon={Mic} title="Painel do Palestrante" subtitle={myPerson?.full_name || user?.full_name} tone="secondary" />

      {/* Minhas Submissões — visível desde a primeira submissão */}
      <SubmissionsSection person={myPerson} />

      {isSpeaker && (
        <>
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
        </>
      )}
    </div>
  );
}
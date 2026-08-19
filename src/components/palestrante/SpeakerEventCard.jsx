/**
 * Card de evento no painel do palestrante.
 * Expande para mostrar lista de sessões com gestão completa.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { ChevronDown, ChevronRight, Calendar, MapPin } from "lucide-react";
import SpeakerSessionRow from "@/components/palestrante/SpeakerSessionRow";
import SpeakerRaffleSection from "@/components/palestrante/SpeakerRaffleSection";

function formatDate(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

export default function SpeakerEventCard({ event, myParticipant, personId, userEmail, user }) {
  const [expanded, setExpanded] = useState(false);

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["speaker-event-sessions", event.id, myParticipant?.id],
    queryFn: async () => {
      if (!myParticipant?.id) return [];
      const res = await base44.functions.invoke('getEventSessions', { eventIds: [event.id] });
      const all = res.data?.sessions || [];
      return all.filter((s) => s.speaker_id === myParticipant.id);
    },
    enabled: expanded && !!myParticipant?.id,
  });

  const sessionIds = sessions.map((s) => s.id);
  const { data: questions = [] } = useQuery({
    queryKey: ["speaker-event-questions-summary", event.id, myParticipant?.id],
    queryFn: async () => {
      if (!sessionIds.length) return [];
      const all = await base44.entities.SessionQuestion.filter({ event_id: event.id, is_deleted: false });
      return all.filter((q) => sessionIds.includes(q.session_id));
    },
    enabled: expanded && sessionIds.length > 0,
  });

  const pendingQ = questions.filter((q) => !q.is_answered).length;

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      {/* Header do evento */}
      <button
        className="w-full flex items-center gap-4 p-4 hover:bg-muted/30 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        {event.logo_url ? (
          <img src={event.logo_url} alt={event.name} className="w-10 h-10 rounded-xl object-cover shrink-0" />
        ) : (
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-base shrink-0"
            style={{ backgroundColor: event.color_primary || "#4F46E5" }}
          >
            {event.name?.[0]?.toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="font-display font-semibold truncate">{event.name}</p>
          <div className="flex flex-wrap items-center gap-3 mt-0.5">
            {event.start_date && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Calendar className="w-3 h-3" /> {formatDate(event.start_date)}
              </span>
            )}
            {event.location && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="w-3 h-3" /> {event.location}
              </span>
            )}
          </div>
        </div>
        {pendingQ > 0 && (
          <span className="shrink-0 text-xs font-semibold bg-primary/10 text-primary px-2.5 py-1 rounded-full">
            {pendingQ} pendente{pendingQ !== 1 ? "s" : ""}
          </span>
        )}
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {/* Conteúdo expandido */}
      {expanded && (
        <div className="border-t border-border">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              Nenhuma palestra encontrada neste evento.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {sessions.map((session) => (
                <SpeakerSessionRow
                  key={session.id}
                  session={session}
                  myParticipant={myParticipant}
                  personId={personId}
                  userEmail={userEmail}
                />
              ))}
            </div>
          )}
          <SpeakerRaffleSection event={event} myParticipant={myParticipant} user={user} />
        </div>
      )}
    </div>
  );
}
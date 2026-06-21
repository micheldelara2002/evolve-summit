/**
 * Visualização da programação do evento para o participante.
 * Agrupa sessões por data e trilha.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Calendar, Clock, MapPin, Mic } from "lucide-react";

const SESSION_TYPE_LABELS = {
  aula: "Aula", debate: "Debate", demonstracao: "Demonstração",
  keynote: "Keynote", mesa_redonda: "Mesa redonda", palestra: "Palestra",
  painel: "Painel", simulacao: "Simulação", workshop: "Workshop",
};

function formatTime(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
}

export default function ProgramacaoView({ eventId }) {
  const { data: sessions = [], isLoading: loadingSessions } = useQuery({
    queryKey: ["sessions", eventId],
    queryFn: () => base44.entities.Session.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: tracks = [] } = useQuery({
    queryKey: ["tracks", eventId],
    queryFn: () => base44.entities.Track.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: rooms = [] } = useQuery({
    queryKey: ["rooms", eventId],
    queryFn: () => base44.entities.Room.filter({ event_id: eventId, is_deleted: false }),
  });

  const trackMap = Object.fromEntries(tracks.map((t) => [t.id, t]));
  const roomMap = Object.fromEntries(rooms.map((r) => [r.id, r]));

  // Group by date
  const byDate = {};
  sessions
    .slice()
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    .forEach((s) => {
      const dateKey = s.start_time ? new Date(s.start_time).toDateString() : "Sem data";
      if (!byDate[dateKey]) byDate[dateKey] = [];
      byDate[dateKey].push(s);
    });

  if (loadingSessions) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Calendar className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p>Nenhuma sessão cadastrada ainda.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {Object.entries(byDate).map(([dateKey, dateSessions]) => (
        <section key={dateKey} className="space-y-3">
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-primary shrink-0" />
            <h2 className="text-sm font-semibold capitalize">{formatDate(dateSessions[0]?.start_time)}</h2>
          </div>

          <div className="space-y-3">
            {dateSessions.map((session) => {
              const track = trackMap[session.track_id];
              const room = roomMap[session.room_id];
              return (
                <div
                  key={session.id}
                  className="bg-card rounded-xl border border-border p-4 hover:shadow-sm transition-shadow"
                  style={track?.color ? { borderLeftColor: track.color, borderLeftWidth: 3 } : {}}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm">{session.title}</p>
                      {session.description && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{session.description}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-3 mt-2">
                        {session.start_time && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="w-3 h-3" />
                            {formatTime(session.start_time)}
                            {session.end_time && ` – ${formatTime(session.end_time)}`}
                          </span>
                        )}
                        {room && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <MapPin className="w-3 h-3" /> {room.name}
                          </span>
                        )}
                        {session.speaker_name && (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Mic className="w-3 h-3" /> {session.speaker_name}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      {session.session_type && (
                        <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
                          {SESSION_TYPE_LABELS[session.session_type] || session.session_type}
                        </span>
                      )}
                      {track && (
                        <span
                          className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
                          style={{ backgroundColor: track.color || "#6366f1" }}
                        >
                          {track.name}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
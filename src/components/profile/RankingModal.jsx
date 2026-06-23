/**
 * Modal de Ranking de Participantes — visão geral e por evento.
 * Top 3 em pódio + lista completa. Somente leitura.
 */
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Trophy, RefreshCw, Medal } from "lucide-react";
import { buildParticipantRanking } from "@/lib/rankingUtils";

function Avatar({ src, name, size = "md" }) {
  const initials = name?.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase() || "?";
  const cls = size === "lg" ? "w-14 h-14 text-lg" : size === "md" ? "w-10 h-10 text-sm" : "w-8 h-8 text-xs";
  if (src) return <img src={src} alt={name} className={`${cls} rounded-full object-cover ring-2 ring-border`} />;
  return <div className={`${cls} rounded-full bg-primary/10 text-primary font-bold flex items-center justify-center`}>{initials}</div>;
}

const MEDAL = ["#FFD700", "#C0C0C0", "#CD7F32"];

export default function RankingModal({ open, onClose, myParticipants = [] }) {
  const [mode, setMode] = useState("geral");
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const eventIds = useMemo(() => [...new Set(myParticipants.map((p) => p.event_id))], [myParticipants]);

  const { data: events = [] } = useQuery({
    queryKey: ["ranking-events", eventIds.join(",")],
    queryFn: async () => {
      if (!eventIds.length) return [];
      const all = await base44.entities.Event.filter({ is_deleted: false });
      return all.filter((e) => eventIds.includes(e.id));
    },
    enabled: open && eventIds.length > 0,
  });

  const { data: participants = [], isLoading } = useQuery({
    queryKey: ["ranking-participants", mode, selectedEventId, refreshKey],
    queryFn: async () => {
      if (mode === "evento" && selectedEventId) {
        return base44.entities.Participant.filter({ event_id: selectedEventId, is_deleted: false });
      }
      return base44.entities.Participant.filter({ is_deleted: false });
    },
    enabled: open,
  });

  const { data: persons = [] } = useQuery({
    queryKey: ["ranking-persons", refreshKey],
    queryFn: () => base44.entities.Person.filter({ is_active: true }),
    enabled: open,
  });

  const ranking = useMemo(
    () => buildParticipantRanking(participants, persons, mode === "evento" ? selectedEventId : null),
    [participants, persons, mode, selectedEventId]
  );

  const top3 = ranking.slice(0, 3);
  const rest = ranking.slice(3);
  const podiumOrder = [1, 0, 2]; // 2º, 1º, 3º no pódio visual

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Trophy className="w-5 h-5 text-primary" /> Ranking de Participantes
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button
              className={`px-3 py-1.5 text-sm font-medium ${mode === "geral" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"}`}
              onClick={() => setMode("geral")}
            >
              Geral
            </button>
            <button
              className={`px-3 py-1.5 text-sm font-medium ${mode === "evento" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"}`}
              onClick={() => setMode("evento")}
            >
              Por evento
            </button>
          </div>
          {mode === "evento" && (
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              value={selectedEventId || ""}
              onChange={(e) => setSelectedEventId(e.target.value)}
            >
              <option value="">Selecione um evento</option>
              {events.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.name}</option>
              ))}
            </select>
          )}
          <Button variant="outline" size="sm" className="ml-auto gap-1" onClick={() => setRefreshKey((k) => k + 1)}>
            <RefreshCw className="w-3.5 h-3.5" /> Atualizar
          </Button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : mode === "evento" && !selectedEventId ? (
          <div className="text-center py-12 text-muted-foreground text-sm">
            Selecione um evento para ver o ranking.
          </div>
        ) : ranking.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Trophy className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>Sem pontuação no período.</p>
          </div>
        ) : (
          <>
            {top3.length > 0 && (
              <div className="flex items-end justify-center gap-2 py-4">
                {podiumOrder.map((idx) => {
                  if (!top3[idx]) return null;
                  const p = top3[idx];
                  const isFirst = idx === 0;
                  return (
                    <div key={p.personId} className="flex flex-col items-center gap-1">
                      <div className="relative">
                        <Avatar src={p.photoUrl} name={p.name} size={isFirst ? "lg" : "md"} />
                        <div className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold text-white" style={{ backgroundColor: MEDAL[idx] }}>
                          {idx + 1}
                        </div>
                      </div>
                      <p className="text-xs font-medium text-center max-w-[90px] truncate">{p.name}</p>
                      <p className="text-sm font-bold text-primary">{p.points} pts</p>
                      <div className={`rounded-t-lg flex items-center justify-center ${isFirst ? "w-16 h-16" : "w-14 h-12"}`} style={{ backgroundColor: MEDAL[idx] + "22" }}>
                        <Medal className={isFirst ? "w-7 h-7" : "w-5 h-5"} style={{ color: MEDAL[idx] }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {rest.length > 0 && (
              <div className="space-y-1">
                {rest.map((p) => (
                  <div key={p.personId} className="flex items-center gap-3 p-2 rounded-lg border border-border bg-card">
                    <span className="w-6 text-center text-sm font-bold text-muted-foreground">{p.position}</span>
                    <Avatar src={p.photoUrl} name={p.name} size="sm" />
                    <span className="flex-1 text-sm font-medium truncate">{p.name}</span>
                    <span className="text-sm font-bold text-primary">{p.points} pts</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
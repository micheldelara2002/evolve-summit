/**
 * Visão de Ranking do Palestrante — métricas de avaliação por sessão.
 * Somente leitura. Mínimo 5 avaliações para ranking principal; abaixo = "Em observação".
 */
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Star, TrendingUp, BarChart3, Eye } from "lucide-react";
import { buildSessionMetrics, normalizeRating } from "@/lib/rankingUtils";

function KpiCard({ icon: Icon, label, value, color = "text-primary" }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${color}`} />
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
      </div>
      <p className={`text-2xl font-display font-bold ${color}`}>{value}</p>
    </div>
  );
}

export default function SpeakerRankingView({ speakerParticipants }) {
  const [eventFilter, setEventFilter] = useState("all");

  const participantIds = speakerParticipants.map((p) => p.id);
  const eventIds = [...new Set(speakerParticipants.map((p) => p.event_id))];

  // Sessões do palestrante — query direcionada por speaker_id ($in)
  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["speaker-ranking-sessions", participantIds.join(",")],
    queryFn: async () => {
      if (!participantIds.length || !eventIds.length) return [];
      const res = await base44.functions.invoke('getEventSessions', { eventIds });
      const all = res.data?.sessions || [];
      // Filtro de apresentação: somente as sessões onde este palestrante é o speaker.
      return all.filter((s) => participantIds.includes(s.speaker_id));
    },
    enabled: participantIds.length > 0,
  });

  const sessionIds = sessions.map((s) => s.id);

  // Reviews das sessões — query direcionada por session_id ($in)
  const { data: reviews = [] } = useQuery({
    queryKey: ["speaker-ranking-reviews", sessionIds.join(",")],
    queryFn: async () => {
      if (!sessionIds.length) return [];
      return base44.entities.SessionReview.filter({
        session_id: { $in: sessionIds },
      });
    },
    enabled: sessionIds.length > 0,
  });

  // Presenças das sessões — query direcionada por session_id ($in)
  const { data: attendances = [] } = useQuery({
    queryKey: ["speaker-ranking-attendances", sessionIds.join(",")],
    queryFn: async () => {
      if (!sessionIds.length) return [];
      return base44.entities.SessionAttendance.filter({
        session_id: { $in: sessionIds },
      });
    },
    enabled: sessionIds.length > 0,
  });

  // Eventos do palestrante — query direcionada por id ($in)
  const { data: events = [] } = useQuery({
    queryKey: ["speaker-ranking-events", eventIds.join(",")],
    queryFn: async () => {
      if (!eventIds.length) return [];
      return base44.entities.Event.filter({
        id: { $in: eventIds },
        is_deleted: false,
      });
    },
    enabled: eventIds.length > 0,
  });

  const eventMap = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);

  const filteredSessions = useMemo(
    () => eventFilter === "all" ? sessions : sessions.filter((s) => s.event_id === eventFilter),
    [sessions, eventFilter]
  );

  const metrics = useMemo(
    () => buildSessionMetrics(filteredSessions, reviews, attendances),
    [filteredSessions, reviews, attendances]
  );

  // KPIs consolidados
  const filteredSessionIds = new Set(filteredSessions.map((s) => s.id));
  const filteredReviews = reviews.filter((r) => filteredSessionIds.has(r.session_id));
  const filteredAttendances = attendances.filter((a) => filteredSessionIds.has(a.session_id) && a.is_present);
  const totalReviews = filteredReviews.length;
  const totalPresences = filteredAttendances.length;
  const avgGeneral = totalReviews > 0
    ? normalizeRating(filteredReviews.reduce((s, r) => s + (r.rating || 0), 0) / totalReviews)
    : 0;
  const avgRate = totalPresences > 0 ? totalReviews / totalPresences : 0;
  const sessionsWithReviews = metrics.filter((m) => m.reviewCount > 0).length;

  const sortedMetrics = [...metrics].sort((a, b) => b.avgRating - a.avgRating);
  const mainRanking = sortedMetrics.filter((m) => !m.isObservable);
  const observacao = sortedMetrics.filter((m) => m.isObservable);

  if (isLoading) {
    return <div className="flex justify-center py-8"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-base font-display font-semibold flex items-center gap-2">
          <Star className="w-4 h-4 text-amber-500" /> Ranking de Avaliações
        </h2>
        <select
          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          value={eventFilter}
          onChange={(e) => setEventFilter(e.target.value)}
        >
          <option value="all">Todos os eventos</option>
          {events.map((ev) => (
            <option key={ev.id} value={ev.id}>{ev.name}</option>
          ))}
        </select>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard icon={Star} label="Média geral (0-10)" value={totalReviews > 0 ? avgGeneral.toFixed(1) : "—"} color="text-amber-500" />
        <KpiCard icon={TrendingUp} label="Taxa média de avaliação" value={totalPresences > 0 ? `${Math.round(avgRate * 100)}%` : "—"} color="text-emerald-600" />
        <KpiCard icon={BarChart3} label="Sessões avaliadas" value={sessionsWithReviews} color="text-indigo-600" />
      </div>

      {/* Tabela por sessão */}
      {sortedMetrics.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          Nenhuma sessão encontrada para o filtro selecionado.
        </div>
      ) : (
        <>
          {mainRanking.length > 0 && (
            <div className="rounded-xl border border-border overflow-hidden">
              <div className="px-4 py-2 bg-muted/40 text-xs font-semibold text-muted-foreground">Ranking Principal</div>
              <div className="divide-y divide-border">
                {mainRanking.map((m, i) => (
                  <SessionMetricRow key={m.session.id} metric={m} position={i + 1} eventName={eventMap.get(m.session.event_id)?.name} />
                ))}
              </div>
            </div>
          )}

          {observacao.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/50 overflow-hidden">
              <div className="px-4 py-2 text-xs font-semibold text-amber-700 flex items-center gap-1.5">
                <Eye className="w-3.5 h-3.5" /> Em observação (menos de 5 avaliações)
              </div>
              <div className="divide-y divide-amber-100">
                {observacao.map((m) => (
                  <SessionMetricRow key={m.session.id} metric={m} position={null} eventName={eventMap.get(m.session.event_id)?.name} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SessionMetricRow({ metric, position, eventName }) {
  const { session, avgRating, reviewCount, presenceCount, evaluationRate } = metric;
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
      {position && <span className="w-6 text-center font-bold text-muted-foreground">{position}</span>}
      {!position && <span className="w-6" />}
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{session.title}</p>
        {eventName && <p className="text-xs text-muted-foreground truncate">{eventName}</p>}
      </div>
      <div className="text-right shrink-0">
        <p className="font-semibold text-amber-600">{avgRating.toFixed(1)}</p>
        <p className="text-[10px] text-muted-foreground">média</p>
      </div>
      <div className="text-right shrink-0 w-16">
        <p className="font-semibold">{reviewCount}/{presenceCount}</p>
        <p className="text-[10px] text-muted-foreground">aval./pres.</p>
      </div>
      <div className="text-right shrink-0 w-14">
        <p className="font-semibold text-emerald-600">{Math.round(evaluationRate * 100)}%</p>
        <p className="text-[10px] text-muted-foreground">taxa</p>
      </div>
    </div>
  );
}
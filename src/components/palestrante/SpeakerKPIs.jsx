/**
 * KPIs consolidados do palestrante (todos os eventos).
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Mic, Star, BookUser, CheckCircle2 } from "lucide-react";
import { normalizeRating } from "@/lib/rankingUtils";

function KpiCard({ icon: Icon, label, value, color = "text-primary" }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${color}`} />
        <span className="text-xs text-muted-foreground font-medium">{label}</span>
      </div>
      <p className={`text-2xl font-display font-bold ${color}`}>{value ?? "—"}</p>
    </div>
  );
}

export default function SpeakerKPIs({ speakerParticipants, events, personId, userEmail }) {
  const participantIds = speakerParticipants.map((p) => p.id);
  const eventIds = speakerParticipants.map((p) => p.event_id);

  // Sessões de que é palestrante — query direcionada por speaker_id ($in)
  const { data: sessions = [] } = useQuery({
    queryKey: ["speaker-sessions-kpi", participantIds.join(",")],
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

  // Reviews das sessões do palestrante — query direcionada por session_id ($in)
  const { data: reviews = [] } = useQuery({
    queryKey: ["speaker-reviews-kpi", sessionIds.join(",")],
    queryFn: async () => {
      if (!sessionIds.length) return [];
      return base44.entities.SessionReview.filter({
        session_id: { $in: sessionIds },
      });
    },
    enabled: sessionIds.length > 0,
  });

  // Mentorias do palestrante — query direcionada por mentor_participant_id ($in)
  const { data: mentorships = [] } = useQuery({
    queryKey: ["speaker-mentorships-kpi", participantIds.join(",")],
    queryFn: async () => {
      if (!participantIds.length) return [];
      return base44.entities.MentorshipRequest.filter({
        mentor_participant_id: { $in: participantIds },
      });
    },
    enabled: participantIds.length > 0,
  });

  // Perguntas das sessões do palestrante — contagens via backend function (autorização server-side)
  const { data: stats = [] } = useQuery({
    queryKey: ["speaker-question-stats", sessionIds.join(",")],
    queryFn: async () => {
      if (!sessionIds.length) return [];
      const res = await base44.functions.invoke('getSpeakerQuestionStats', { sessionIds });
      return res.data?.stats || [];
    },
    enabled: sessionIds.length > 0,
  });

  const avgRating = reviews.length
    ? normalizeRating(reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length).toFixed(1)
    : null;

  const totalQ = stats.reduce((s, x) => s + (x.total || 0), 0);
  const answeredQ = stats.reduce((s, x) => s + (x.answered || 0), 0);
  const pctAnswered = totalQ > 0 ? Math.round((answeredQ / totalQ) * 100) : null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      <KpiCard icon={Mic} label="Eventos" value={events.length} color="text-violet-600" />
      <KpiCard icon={Mic} label="Palestras" value={sessions.length} color="text-indigo-600" />
      <KpiCard icon={Star} label="Média Avaliação" value={avgRating ? `${avgRating}/10` : "—"} color="text-amber-500" />
      <KpiCard icon={BookUser} label="Mentorias" value={mentorships.length} color="text-teal-600" />
      <KpiCard
        icon={CheckCircle2}
        label="% Respondidas"
        value={pctAnswered !== null ? `${pctAnswered}%` : "—"}
        color="text-emerald-600"
      />
    </div>
  );
}
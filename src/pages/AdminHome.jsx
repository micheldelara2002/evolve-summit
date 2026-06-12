import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { t } from "@/lib/i18n";
import { filterEventsByAccess } from "@/lib/access";
import DashboardCard from "@/components/admin/DashboardCard";
import KpiCard from "@/components/admin/KpiCard";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Activity, TrendingUp, Calendar, Shield,
  Wifi, Clock, AlertTriangle, XCircle,
  Upload, Bell, Users, CheckSquare,
  BarChart3, Star, MessageSquare, Handshake,
  Target, ArrowRight,
} from "lucide-react";

export default function AdminHome() {
  const { user } = useAuth();

  const { data: events = [] } = useQuery({
    queryKey: ["events"],
    queryFn: () => base44.entities.Event.filter({ is_deleted: false }),
  });

  const { data: participants = [] } = useQuery({
    queryKey: ["participants-all"],
    queryFn: () => base44.entities.Participant.filter({ is_deleted: false }),
  });

  const { data: checkins = [] } = useQuery({
    queryKey: ["checkins-all"],
    queryFn: () => base44.entities.Checkin.list(),
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions-all"],
    queryFn: () => base44.entities.Session.filter({ is_deleted: false }),
  });

  const { data: reviews = [] } = useQuery({
    queryKey: ["reviews-all"],
    queryFn: () => base44.entities.SessionReview.list(),
  });

  const { data: questions = [] } = useQuery({
    queryKey: ["questions-all"],
    queryFn: () => base44.entities.SessionQuestion.list(),
  });

  const { data: mentorships = [] } = useQuery({
    queryKey: ["mentorships-all"],
    queryFn: () => base44.entities.MentorshipRequest.list(),
  });

  const { data: leads = [] } = useQuery({
    queryKey: ["leads-all"],
    queryFn: () => base44.entities.Lead.list(),
  });

  const { data: imports = [] } = useQuery({
    queryKey: ["imports-all"],
    queryFn: () => base44.entities.Import.list(),
  });

  const scopedEvents = filterEventsByAccess(events, user);
  const scopedIds = new Set(scopedEvents.map((e) => e.id));
  const scopedParticipants = participants.filter((p) => scopedIds.has(p.event_id));
  const scopedCheckins = checkins.filter((c) => scopedIds.has(c.event_id) && !c.is_reverted);
  const scopedSessions = sessions.filter((s) => scopedIds.has(s.event_id));
  const scopedReviews = reviews.filter((r) => scopedIds.has(r.event_id));

  const activeEvents = scopedEvents.filter((e) => e.status === "active");
  const finishedEvents = scopedEvents.filter((e) => e.status === "finished");
  const attendanceRate = scopedParticipants.length > 0
    ? ((scopedCheckins.length / scopedParticipants.length) * 100).toFixed(1)
    : "0";
  const avgRating = scopedReviews.length > 0
    ? (scopedReviews.reduce((s, r) => s + (r.rating || 0), 0) / scopedReviews.length).toFixed(1)
    : "—";

  const now = new Date();
  const h24 = new Date(now - 24 * 60 * 60 * 1000);
  const d7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const failedImports24h = imports.filter(
    (i) => i.status === "failed" && new Date(i.created_date) > h24
  ).length;
  const failedImports7d = imports.filter(
    (i) => i.status === "failed" && new Date(i.created_date) > d7
  ).length;

  const scopedMentorships = mentorships.filter((m) => scopedIds.has(m.event_id));
  const scopedQuestions = questions.filter((q) => scopedIds.has(q.event_id));
  const scopedLeads = leads.filter((l) => scopedIds.has(l.event_id));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-display font-bold">{t("home.title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {user?.full_name} · {user?.role === "admin" ? "Admin Global" : "Manager"}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 1 — Saúde do Sistema */}
        <DashboardCard title={t("home.systemHealth")} icon={Activity}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <KpiCard label={t("health.uptime")} value="99.7%" icon={Wifi} color="text-emerald-600" />
            <KpiCard label={t("health.apiLatency")} value="120ms" icon={Clock} color="text-sky-600" />
            <KpiCard label={t("health.checkinLatency")} value="340ms" icon={Clock} color="text-sky-600" />
            <KpiCard label={t("health.errorRate")} value="0.3%" icon={XCircle} color="text-red-500" />
            <KpiCard label={t("health.importFailures24h")} value={String(failedImports24h)} icon={Upload} color="text-amber-600" />
            <KpiCard label={t("health.activeAlerts")} value="0" icon={Bell} color="text-emerald-600" />
          </div>
        </DashboardCard>

        {/* 2 — Negócio */}
        <DashboardCard title={t("home.business")} icon={TrendingUp}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <KpiCard label={t("business.totalEvents")} value={String(scopedEvents.length)} icon={Calendar} />
            <KpiCard label={t("business.activeEvents")} value={String(activeEvents.length)} icon={Calendar} color="text-emerald-600" />
            <KpiCard label={t("business.finishedEvents")} value={String(finishedEvents.length)} icon={Calendar} color="text-sky-600" />
            <KpiCard label={t("business.totalParticipants")} value={String(scopedParticipants.length)} icon={Users} />
            <KpiCard label={t("business.checkins")} value={String(scopedCheckins.length)} icon={CheckSquare} color="text-emerald-600" />
            <KpiCard label={t("business.attendanceRate")} value={`${attendanceRate}%`} icon={BarChart3} />
            <KpiCard label={t("business.sessions")} value={String(scopedSessions.length)} icon={Calendar} color="text-sky-600" />
            <KpiCard label={t("business.avgRating")} value={avgRating} icon={Star} color="text-amber-500" />
            <KpiCard label={t("business.questions")} value={String(scopedQuestions.length)} icon={MessageSquare} />
            <KpiCard label={t("business.mentorshipsRequested")} value={String(scopedMentorships.length)} icon={Handshake} />
            <KpiCard label={t("business.mentorshipsCompleted")} value={String(scopedMentorships.filter((m) => m.status === "completed").length)} icon={Handshake} color="text-emerald-600" />
            <KpiCard label={t("business.leadsGenerated")} value={String(scopedLeads.length)} icon={Target} color="text-amber-600" />
          </div>
        </DashboardCard>

        {/* 3 — Gestão de Eventos */}
        <DashboardCard
          title={t("home.eventManagement")}
          icon={Calendar}
          action={
            <Link to="/events">
              <Button variant="ghost" size="sm" className="gap-1 text-xs">
                {t("events.title")} <ArrowRight className="w-3 h-3" />
              </Button>
            </Link>
          }
        >
          <div className="space-y-2">
            {scopedEvents.slice(0, 5).map((event) => (
              <Link
                key={event.id}
                to={`/events/${event.id}`}
                className="flex items-center justify-between p-2.5 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {event.logo_url ? (
                    <img src={event.logo_url} alt="" className="w-8 h-8 rounded-md object-cover" />
                  ) : (
                    <div
                      className="w-8 h-8 rounded-md flex items-center justify-center text-white text-xs font-bold"
                      style={{ backgroundColor: event.color_primary || "#4F46E5" }}
                    >
                      {event.name?.[0]?.toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{event.name}</p>
                    <p className="text-xs text-muted-foreground">{t(`status.${event.status}`)}</p>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              </Link>
            ))}
            {scopedEvents.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">{t("events.noEvents")}</p>
            )}
          </div>
        </DashboardCard>

        {/* 4 — Auditoria */}
        <DashboardCard
          title={t("home.audit")}
          icon={Shield}
          action={
            <Link to="/audit">
              <Button variant="ghost" size="sm" className="gap-1 text-xs">
                {t("audit.title")} <ArrowRight className="w-3 h-3" />
              </Button>
            </Link>
          }
        >
          <RecentAudit />
        </DashboardCard>
      </div>
    </div>
  );
}

function RecentAudit() {
  const { data: logs = [] } = useQuery({
    queryKey: ["audit-recent"],
    queryFn: () => base44.entities.AuditLog.list("-created_date", 5),
  });

  if (logs.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-4">{t("audit.noLogs")}</p>;
  }

  return (
    <div className="space-y-2">
      {logs.map((log) => (
        <div key={log.id} className="p-2.5 rounded-lg bg-muted/50 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium truncate">{t(`actions.${log.action}`) || log.action}</span>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {new Date(log.created_date).toLocaleDateString("pt-BR")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {log.user_name} · {log.entity_type}
          </p>
        </div>
      ))}
    </div>
  );
}
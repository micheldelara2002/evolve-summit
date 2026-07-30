import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { ArrowLeft, RefreshCw, TrendingUp, Users, UserCheck, CheckCircle2, XCircle, Building2, UserPlus, Target } from "lucide-react";
import { useNavigate } from "react-router-dom";
import BusinessFilters from "@/components/business/BusinessFilters";
import BusinessKPICard from "@/components/business/BusinessKPICard";
import BusinessCharts from "@/components/business/BusinessCharts";
import BusinessTopEventsTable from "@/components/business/BusinessTopEventsTable";
import BusinessEventsByMonth from "@/components/business/BusinessEventsByMonth";
import { getPeriodRange, getPreviousRange, inRange, pctChange, formatDateTime, getBucketKey, formatBucketLabel, getBucketType } from "@/lib/businessUtils";

const FETCH_LIMIT = 10000;

export default function BusinessDashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Filter state
  const [period, setPeriod] = useState("3m");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [eventFilter, setEventFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [profileFilter, setProfileFilter] = useState("all");

  // Queries
  const usersQ = useQuery({ queryKey: ["business", "users"], queryFn: () => base44.entities.User.list("-created_date", FETCH_LIMIT) });
  const personsQ = useQuery({ queryKey: ["business", "persons"], queryFn: () => base44.entities.Person.filter({}, "-created_date", FETCH_LIMIT) });
  const eventsQ = useQuery({ queryKey: ["business", "events"], queryFn: () => base44.entities.Event.filter({ is_deleted: false }, "-created_date", FETCH_LIMIT) });
  const partnersQ = useQuery({ queryKey: ["business", "partners"], queryFn: () => base44.entities.Partner.filter({ is_deleted: false }, "-created_date", FETCH_LIMIT) });
  const participantsQ = useQuery({ queryKey: ["business", "participants"], queryFn: () => base44.entities.Participant.filter({ is_deleted: false }, "-created_date", FETCH_LIMIT) });
  const leadsQ = useQuery({ queryKey: ["business", "leads"], queryFn: () => base44.entities.Lead.filter({}, "-created_date", FETCH_LIMIT) });

  const users = usersQ.data || [];
  const persons = personsQ.data || [];
  const events = eventsQ.data || [];
  const partners = partnersQ.data || [];
  const participants = participantsQ.data || [];
  const leads = leadsQ.data || [];

  // Period ranges
  const { current, previous } = useMemo(() => {
    const c = getPeriodRange(period, customStart, customEnd);
    const p = getPreviousRange(c.start, c.end);
    return { current: c, previous: p };
  }, [period, customStart, customEnd]);

  // Metrics
  const metrics = useMemo(() => {
    // === Events: exclude draft and cancelled ===
    const validEvents = events.filter((e) => e.status === "active" || e.status === "finished");
    const statusEvents = statusFilter === "all" ? validEvents : validEvents.filter((e) => e.status === statusFilter);
    const eventScopedEvents = eventFilter === "all" ? statusEvents : statusEvents.filter((e) => e.id === eventFilter);
    const currentEvents = eventScopedEvents.filter((e) => inRange(e.start_date, current.start, current.end));
    const prevEvents = eventScopedEvents.filter((e) => inRange(e.start_date, previous.start, previous.end));

    const activeNow = currentEvents.filter((e) => e.status === "active").length;
    const activePrev = prevEvents.filter((e) => e.status === "active").length;
    const finishedNow = currentEvents.filter((e) => e.status === "finished").length;
    const finishedPrev = prevEvents.filter((e) => e.status === "finished").length;

    // === Users ===
    const usersNow = users.filter((u) => inRange(u.created_date, current.start, current.end)).length;
    const usersPrev = users.filter((u) => inRange(u.created_date, previous.start, previous.end)).length;

    // === Persons ===
    const personsNow = persons.filter((p) => inRange(p.created_date, current.start, current.end)).length;
    const personsPrev = persons.filter((p) => inRange(p.created_date, previous.start, previous.end)).length;

    // === Partners ===
    const partnersNow = partners.filter((p) => inRange(p.created_date, current.start, current.end)).length;
    const partnersPrev = partners.filter((p) => inRange(p.created_date, previous.start, previous.end)).length;

    // === Participants (event + profile scoped) ===
    const eventParticipants = eventFilter === "all" ? participants : participants.filter((p) => p.event_id === eventFilter);
    const profileParticipants = profileFilter === "all" ? eventParticipants : eventParticipants.filter((p) => p.role_in_event === profileFilter);

    const currentParticipants = profileParticipants.filter((p) => inRange(p.created_date, current.start, current.end));
    const prevParticipants = profileParticipants.filter((p) => inRange(p.created_date, previous.start, previous.end));

    const uniqKey = (p) => `${p.event_id}:${p.person_id || p.id}`;
    const uniqNow = new Set(currentParticipants.map(uniqKey)).size;
    const uniqPrev = new Set(prevParticipants.map(uniqKey)).size;

    // === Leads (event scoped) ===
    const eventLeads = eventFilter === "all" ? leads : leads.filter((l) => l.event_id === eventFilter);
    const currentLeads = eventLeads.filter((l) => inRange(l.created_date, current.start, current.end));
    const prevLeads = eventLeads.filter((l) => inRange(l.created_date, previous.start, previous.end));

    // === Chart: participants evolution ===
    const days = (current.end - current.start) / (1000 * 60 * 60 * 24);
    const bucketType = getBucketType(days);
    const buckets = new Map();
    profileParticipants.forEach((p) => {
      if (!inRange(p.created_date, current.start, current.end)) return;
      const key = getBucketKey(p.created_date, bucketType);
      if (!buckets.has(key)) buckets.set(key, new Set());
      buckets.get(key).add(uniqKey(p));
    });
    const participantsEvolution = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, set]) => ({ date: formatBucketLabel(key, bucketType), count: set.size }));

    // === Chart: leads by partner ===
    const partnerMap = new Map(partners.map((p) => [p.id, p.trade_name || p.legal_name || "Sem nome"]));
    const leadsByPartnerMap = new Map();
    currentLeads.forEach((l) => {
      const name = partnerMap.get(l.partner_id) || "Sem parceiro";
      leadsByPartnerMap.set(name, (leadsByPartnerMap.get(name) || 0) + 1);
    });
    const leadsByPartner = Array.from(leadsByPartnerMap.entries())
      .map(([name, count]) => ({ name, leads: count }))
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 10);

    // === Chart: events status ===
    const eventsStatus = [
      { name: "Ativos", value: activeNow },
      { name: "Encerrados", value: finishedNow },
    ];

    // === Top events table ===
    const participantsByEvent = new Map();
    profileParticipants.forEach((p) => {
      if (!participantsByEvent.has(p.event_id)) participantsByEvent.set(p.event_id, new Set());
      participantsByEvent.get(p.event_id).add(p.person_id || p.id);
    });
    const leadsByEvent = new Map();
    eventLeads.forEach((l) => {
      leadsByEvent.set(l.event_id, (leadsByEvent.get(l.event_id) || 0) + 1);
    });
    const topEvents = eventScopedEvents
      .map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        uniqueParticipants: participantsByEvent.get(e.id)?.size || 0,
        leads: leadsByEvent.get(e.id) || 0,
      }))
      .sort((a, b) => b.uniqueParticipants - a.uniqueParticipants)
      .slice(0, 10);

    return {
      users: { count: usersNow, delta: pctChange(usersNow, usersPrev) },
      persons: { count: personsNow, delta: pctChange(personsNow, personsPrev) },
      eventsActive: { count: activeNow, delta: pctChange(activeNow, activePrev) },
      eventsFinished: { count: finishedNow, delta: pctChange(finishedNow, finishedPrev) },
      partners: { count: partnersNow, delta: pctChange(partnersNow, partnersPrev) },
      uniqueParticipants: { count: uniqNow, delta: pctChange(uniqNow, uniqPrev) },
      leads: { count: currentLeads.length, delta: pctChange(currentLeads.length, prevLeads.length) },
      participantsEvolution,
      leadsByPartner,
      eventsStatus,
      topEvents,
    };
  }, [users, persons, events, partners, participants, leads, current, previous, eventFilter, statusFilter, profileFilter]);

  const handleRefresh = () => queryClient.invalidateQueries({ queryKey: ["business"] });

  const anyLoading = usersQ.isLoading || personsQ.isLoading || eventsQ.isLoading || partnersQ.isLoading || participantsQ.isLoading || leadsQ.isLoading;
  const anyFetching = usersQ.isFetching || personsQ.isFetching || eventsQ.isFetching || partnersQ.isFetching || participantsQ.isFetching || leadsQ.isFetching;

  const lastUpdate = Math.max(
    usersQ.dataUpdatedAt, personsQ.dataUpdatedAt, eventsQ.dataUpdatedAt,
    partnersQ.dataUpdatedAt, participantsQ.dataUpdatedAt, leadsQ.dataUpdatedAt
  );

  // Events for filter dropdown (active + finished only)
  const dropdownEvents = events.filter((e) => e.status === "active" || e.status === "finished");

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-display font-bold leading-tight">Painel Executivo</h1>
              <p className="text-xs text-muted-foreground hidden sm:block">Indicadores de negócio em tempo real</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdate > 0 && (
            <span className="text-xs text-muted-foreground hidden md:inline">
              Atualizado: {formatDateTime(lastUpdate)}
            </span>
          )}
          <BusinessFilters
            period={period} setPeriod={setPeriod}
            customStart={customStart} setCustomStart={setCustomStart}
            customEnd={customEnd} setCustomEnd={setCustomEnd}
            eventFilter={eventFilter} setEventFilter={setEventFilter}
            events={dropdownEvents}
            statusFilter={statusFilter} setStatusFilter={setStatusFilter}
            profileFilter={profileFilter} setProfileFilter={setProfileFilter}
          />
          <Button variant="outline" size="icon" onClick={handleRefresh} disabled={anyFetching}>
            <RefreshCw className={`w-4 h-4 ${anyFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Big Numbers */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <BusinessKPICard icon={Users} label="Usuários" value={metrics.users.count} delta={metrics.users.delta} loading={usersQ.isLoading} error={usersQ.isError} accent="primary" />
        <BusinessKPICard icon={UserCheck} label="Pessoas" value={metrics.persons.count} delta={metrics.persons.delta} loading={personsQ.isLoading} error={personsQ.isError} accent="secondary" />
        <BusinessKPICard icon={CheckCircle2} label="Eventos ativos" value={metrics.eventsActive.count} delta={metrics.eventsActive.delta} loading={eventsQ.isLoading} error={eventsQ.isError} accent="success" />
        <BusinessKPICard icon={XCircle} label="Eventos encerrados" value={metrics.eventsFinished.count} delta={metrics.eventsFinished.delta} loading={eventsQ.isLoading} error={eventsQ.isError} accent="warning" />
        <BusinessKPICard icon={Building2} label="Parceiros" value={metrics.partners.count} delta={metrics.partners.delta} loading={partnersQ.isLoading} error={partnersQ.isError} accent="accent" />
        <BusinessKPICard icon={UserPlus} label="Participantes únicos" value={metrics.uniqueParticipants.count} delta={metrics.uniqueParticipants.delta} loading={participantsQ.isLoading} error={participantsQ.isError} accent="destructive" />
        <BusinessKPICard icon={Target} label="Leads gerados" value={metrics.leads.count} delta={metrics.leads.delta} loading={leadsQ.isLoading} error={leadsQ.isError} accent="primary" />
      </div>

      {/* Charts */}
      <div className="space-y-4">
        <BusinessEventsByMonth events={events} />
        <BusinessCharts
          participantsEvolution={metrics.participantsEvolution}
          leadsByPartner={metrics.leadsByPartner}
          eventsStatus={metrics.eventsStatus}
          loading={anyLoading}
          error={eventsQ.isError || participantsQ.isError || leadsQ.isError}
        />
      </div>

      {/* Top events table */}
      <BusinessTopEventsTable
        data={metrics.topEvents}
        loading={anyLoading}
        error={eventsQ.isError || participantsQ.isError || leadsQ.isError}
      />
    </div>
  );
}
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { RefreshCw, TrendingUp, Users, UserCheck, CheckCircle2, XCircle, Building2, UserPlus, Target } from "lucide-react";
import BusinessFilters from "@/components/business/BusinessFilters";
import BusinessKPICard from "@/components/business/BusinessKPICard";
import BusinessCharts from "@/components/business/BusinessCharts";
import BusinessTopEventsTable from "@/components/business/BusinessTopEventsTable";
import BusinessEventsByMonth from "@/components/business/BusinessEventsByMonth";
import BusinessSalesSection from "@/components/business/BusinessSalesSection";
import PageHeader from "@/components/layout/PageHeader";
import { formatDateTime } from "@/lib/businessUtils";

export default function BusinessDashboard() {
  const queryClient = useQueryClient();

  // Filter state
  const [period, setPeriod] = useState("3m");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [eventFilter, setEventFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [profileFilter, setProfileFilter] = useState("all");

  // P0.3: Backend-driven aggregation — single function call replaces 6 global
  // queries (FETCH_LIMIT=10000 each) + client-side Array.reduce useMemo.
  const { data, isLoading, isFetching, isError, dataUpdatedAt } = useQuery({
    queryKey: ["business", "metrics", period, customStart, customEnd, eventFilter, statusFilter, profileFilter],
    queryFn: async () => {
      const res = await base44.functions.invoke('getBusinessDashboardMetrics', {
        period, customStart, customEnd, eventFilter, statusFilter, profileFilter,
      });
      return res.data;
    },
  });

  const kpis = data?.kpis || {};
  const participantsEvolution = data?.participantsEvolution || [];
  const leadsByPartner = data?.leadsByPartner || [];
  const eventsStatus = data?.eventsStatus || [];
  const topEvents = data?.topEvents || [];
  const events = data?.events || [];

  const handleRefresh = () => queryClient.invalidateQueries({ queryKey: ["business"] });

  const lastUpdate = dataUpdatedAt || 0;

  // Events for filter dropdown (active + finished only)
  const dropdownEvents = events.filter((e) => e.status === "active" || e.status === "finished");

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <PageHeader
        icon={TrendingUp}
        title="Painel Executivo"
        subtitle="Indicadores de negócio em tempo real"
        tone="primary"
        actions={
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
            <Button variant="outline" size="icon" onClick={handleRefresh} disabled={isFetching}>
              <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        }
      />

      {/* Big Numbers */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <BusinessKPICard icon={Users} label="Usuários" value={kpis.users?.count} delta={kpis.users?.delta} loading={isLoading} error={isError} accent="primary" />
        <BusinessKPICard icon={UserCheck} label="Pessoas" value={kpis.persons?.count} delta={kpis.persons?.delta} loading={isLoading} error={isError} accent="secondary" />
        <BusinessKPICard icon={CheckCircle2} label="Eventos ativos" value={kpis.eventsActive?.count} delta={kpis.eventsActive?.delta} loading={isLoading} error={isError} accent="success" />
        <BusinessKPICard icon={XCircle} label="Eventos encerrados" value={kpis.eventsFinished?.count} delta={kpis.eventsFinished?.delta} loading={isLoading} error={isError} accent="warning" />
        <BusinessKPICard icon={Building2} label="Parceiros" value={kpis.partners?.count} delta={kpis.partners?.delta} loading={isLoading} error={isError} accent="accent" />
        <BusinessKPICard icon={UserPlus} label="Participantes únicos" value={kpis.uniqueParticipants?.count} delta={kpis.uniqueParticipants?.delta} loading={isLoading} error={isError} accent="destructive" />
        <BusinessKPICard icon={Target} label="Leads gerados" value={kpis.leads?.count} delta={kpis.leads?.delta} loading={isLoading} error={isError} accent="primary" />
      </div>

      {/* Charts */}
      <div className="space-y-4">
        <BusinessEventsByMonth events={events} />
        <BusinessCharts
          participantsEvolution={participantsEvolution}
          leadsByPartner={leadsByPartner}
          eventsStatus={eventsStatus}
          loading={isLoading}
          error={isError}
        />
      </div>

      {/* Top events table */}
      <BusinessTopEventsTable
        data={topEvents}
        loading={isLoading}
        error={isError}
      />

      <BusinessSalesSection
        period={period}
        customStart={customStart}
        customEnd={customEnd}
        eventFilter={eventFilter}
      />
    </div>
  );
}
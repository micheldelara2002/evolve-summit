/**
 * Tela de métricas de notificações — reutilizável por contexto.
 *   /notifications/metrics                   → admin global (todas campanhas)
 *   /events/:eventId/notifications/metrics   → evento específico (gerente/staff/admin)
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Bell, Users, BookOpen, MousePointerClick, TrendingUp, AlertTriangle, Send } from "lucide-react";
import { format, subDays, isAfter } from "date-fns";
import { ptBR } from "date-fns/locale";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line } from "recharts";

const STATUS_LABELS = {
  draft: "Rascunho", scheduled: "Agendado", processing: "Processando",
  sent: "Enviado", partially_sent: "Parcial", canceled: "Cancelado", failed: "Falhou",
};
const STATUS_COLORS = {
  draft: "bg-muted text-muted-foreground",
  sent: "bg-green-100 text-green-700",
  partially_sent: "bg-orange-100 text-orange-700",
  scheduled: "bg-blue-100 text-blue-700",
  processing: "bg-yellow-100 text-yellow-700",
  failed: "bg-red-100 text-red-700",
  canceled: "bg-red-100 text-red-700",
};

export default function NotificationMetrics() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  const isEventScope = !!eventId;
  const isAdmin = user?.role === "admin";
  const backPath = isEventScope ? `/events/${eventId}` : "/notifications";

  const [periodDays, setPeriodDays] = useState("30");
  const [statusFilter, setStatusFilter] = useState("all");
  // Admin global: filtrar por evento específico
  const [filterEventId, setFilterEventId] = useState("all");

  // Redirecionar gerente/staff tentando acessar a rota global
  if (!isEventScope && !isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <p className="text-muted-foreground">Acesso restrito a administradores.</p>
        <Button variant="outline" onClick={() => navigate("/")}>Voltar ao início</Button>
      </div>
    );
  }

  return (
    <MetricsContent
      isEventScope={isEventScope}
      eventId={eventId}
      isAdmin={isAdmin}
      backPath={backPath}
      periodDays={periodDays}
      setPeriodDays={setPeriodDays}
      statusFilter={statusFilter}
      setStatusFilter={setStatusFilter}
      filterEventId={filterEventId}
      setFilterEventId={setFilterEventId}
    />
  );
}

function MetricsContent({
  isEventScope, eventId, isAdmin, backPath,
  periodDays, setPeriodDays, statusFilter, setStatusFilter,
  filterEventId, setFilterEventId,
}) {
  const navigate = useNavigate();

  // Buscar o evento atual (se contexto de evento)
  const { data: currentEvent } = useQuery({
    queryKey: ["event_metrics", eventId],
    queryFn: async () => {
      const list = await base44.entities.Event.filter({ id: eventId });
      return list[0] || null;
    },
    enabled: isEventScope && !!eventId,
  });

  // Buscar todos os eventos (admin global, para o filtro)
  const { data: allEvents = [] } = useQuery({
    queryKey: ["events_metrics_filter"],
    queryFn: () => base44.entities.Event.filter({ is_deleted: false }),
    enabled: !isEventScope && isAdmin,
  });

  // Buscar campanhas conforme escopo
  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ["notification_campaigns_metrics", isEventScope ? "event" : "global", eventId],
    queryFn: () => {
      if (isEventScope) {
        // Escopo de evento: somente campanhas deste evento
        return base44.entities.NotificationCampaign.filter({
          is_deleted: false,
          scope_type: "event",
          scope_event_id: eventId,
        });
      }
      // Admin global: busca tudo (globais + todos os eventos)
      return base44.entities.NotificationCampaign.filter({ is_deleted: false });
    },
  });

  // Buscar recipients para calcular cliques — paginação em batches (BATCH_SIZE=500,
  // skip+limit, sort "id") para evitar truncamento em campanhas com >1000 recipients.
  // Filtra por campaign_ids relevantes no banco (não carrega recipients globais).
  // Retorna um mapa { campaign_id: click_count } — memória O(batch), não O(total).
  const campaignIds = campaigns.map((c) => c.id);
  const { data: clickCounts = {} } = useQuery({
    queryKey: ["notification_recipient_clicks", campaignIds.join(",")],
    queryFn: async () => {
      if (!campaignIds.length) return {};
      const counts = {};
      let skip = 0;
      while (true) {
        const batch = await base44.entities.NotificationRecipient.filter(
          { campaign_id: { $in: campaignIds } }, "id", 500, skip
        );
        if (batch.length === 0) break;
        for (const r of batch) {
          if (!r.clicked_at) continue;
          counts[r.campaign_id] = (counts[r.campaign_id] || 0) + 1;
        }
        skip += 500;
        if (batch.length < 500) break;
      }
      return counts;
    },
    enabled: campaignIds.length > 0,
  });

  // Filtros aplicados
  const cutoff = subDays(new Date(), parseInt(periodDays));
  const filteredCampaigns = campaigns.filter((c) => {
    const date = new Date(c.sent_at || c.created_date);
    if (!isAfter(date, cutoff)) return false;
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    // Filtro de evento (somente admin global)
    if (!isEventScope && isAdmin && filterEventId !== "all") {
      if (filterEventId === "global" && c.scope_type !== "global") return false;
      if (filterEventId !== "global" && c.scope_event_id !== filterEventId) return false;
    }
    return true;
  });

  // KPIs
  const totalCampaigns = filteredCampaigns.length;
  const sentCampaigns = filteredCampaigns.filter((c) => c.status === "sent" || c.status === "partially_sent");
  const failedCampaigns = filteredCampaigns.filter((c) => c.status === "failed");
  const totalRecipients = filteredCampaigns.reduce((s, c) => s + (c.recipients_count || 0), 0);
  const totalDelivered = filteredCampaigns.reduce((s, c) => s + (c.delivered_count || 0), 0);
  const totalRead = filteredCampaigns.reduce((s, c) => s + (c.read_count || 0), 0);
  const readRate = totalDelivered > 0 ? ((totalRead / totalDelivered) * 100).toFixed(1) : "0.0";
  const totalClicks = filteredCampaigns.reduce((s, c) => s + (clickCounts[c.id] || 0), 0);

  // Série temporal por dia (apenas enviadas)
  const dayMap = {};
  sentCampaigns.forEach((c) => {
    const day = format(new Date(c.sent_at || c.created_date), "dd/MM");
    if (!dayMap[day]) dayMap[day] = { day, enviadas: 0, lidas: 0 };
    dayMap[day].enviadas += c.recipients_count || 0;
    dayMap[day].lidas += c.read_count || 0;
  });
  const chartData = Object.values(dayMap).slice(-14);

  const kpis = [
    { label: "Total Campanhas", value: totalCampaigns, icon: Bell, color: "text-primary" },
    { label: "Total Destinatários", value: totalRecipients, icon: Users, color: "text-secondary" },
    { label: "Entregues", value: totalDelivered, icon: Send, color: "text-blue-600" },
    { label: "Total Lidas", value: totalRead, icon: BookOpen, color: "text-green-600" },
    { label: "Taxa de Leitura", value: `${readRate}%`, icon: TrendingUp, color: "text-accent" },
    { label: "Cliques CTA", value: totalClicks, icon: MousePointerClick, color: "text-purple-600" },
    { label: "Falhas", value: failedCampaigns.length, icon: AlertTriangle, color: "text-destructive" },
  ];

  const scopeLabel = isEventScope
    ? `Métricas do Evento: ${currentEvent?.name || "..."}`
    : "Métricas Globais";

  const scopeSubtitle = isEventScope
    ? "Campanhas deste evento"
    : "Todas as campanhas — globais e por evento";

  const getEventName = (id) => allEvents.find((e) => e.id === id)?.name || "—";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(backPath)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-display font-bold">{scopeLabel}</h1>
          <p className="text-sm text-muted-foreground">{scopeSubtitle}</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={periodDays} onValueChange={setPeriodDays}>
          <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Últimos 7 dias</SelectItem>
            <SelectItem value="30">Últimos 30 dias</SelectItem>
            <SelectItem value="90">Últimos 90 dias</SelectItem>
            <SelectItem value="365">Último ano</SelectItem>
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="sent">Enviado</SelectItem>
            <SelectItem value="draft">Rascunho</SelectItem>
            <SelectItem value="scheduled">Agendado</SelectItem>
            <SelectItem value="failed">Falhou</SelectItem>
          </SelectContent>
        </Select>

        {/* Filtro de evento — apenas admin global */}
        {!isEventScope && isAdmin && (
          <Select value={filterEventId} onValueChange={setFilterEventId}>
            <SelectTrigger className="w-52 h-9"><SelectValue placeholder="Todos os eventos" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os eventos</SelectItem>
              <SelectItem value="global">Somente globais</SelectItem>
              {allEvents.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start justify-between gap-1">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground leading-tight">{kpi.label}</p>
                  <p className={`text-xl font-display font-bold mt-1 ${kpi.color}`}>{kpi.value}</p>
                </div>
                <kpi.icon className={`w-4 h-4 shrink-0 ${kpi.color} opacity-60`} />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Gráficos */}
      {chartData.length > 0 && (
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Envios por dia (destinatários)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={chartData}>
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="enviadas" name="Enviadas" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Leituras por dia</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartData}>
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="lidas" name="Lidas" stroke="hsl(var(--secondary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Tabela de campanhas */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Campanhas ({filteredCampaigns.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 text-center text-muted-foreground">Carregando...</div>
          ) : filteredCampaigns.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">Nenhuma campanha no período.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left p-3 font-medium text-muted-foreground">Título</th>
                    {!isEventScope && (
                      <th className="text-left p-3 font-medium text-muted-foreground">Escopo</th>
                    )}
                    <th className="text-left p-3 font-medium text-muted-foreground">Status</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Dest.</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Entregues</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Lidas</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Taxa</th>
                    <th className="text-left p-3 font-medium text-muted-foreground">Envio</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCampaigns.map((c) => {
                    const base = c.delivered_count || c.recipients_count || 0;
                    const rate = base > 0 ? (((c.read_count || 0) / base) * 100).toFixed(0) : 0;
                    const scopeChip = c.scope_type === "global"
                      ? <Badge variant="outline" className="text-xs px-1.5 py-0">Global</Badge>
                      : <Badge variant="outline" className="text-xs px-1.5 py-0">{getEventName(c.scope_event_id)}</Badge>;
                    return (
                      <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                        <td className="p-3 max-w-[180px] truncate font-medium">{c.title}</td>
                        {!isEventScope && <td className="p-3">{scopeChip}</td>}
                        <td className="p-3">
                          <Badge className={STATUS_COLORS[c.status] || "bg-muted text-muted-foreground"}>
                            {STATUS_LABELS[c.status] || c.status}
                          </Badge>
                        </td>
                        <td className="p-3 text-right">{c.recipients_count || 0}</td>
                        <td className="p-3 text-right">{c.delivered_count || 0}</td>
                        <td className="p-3 text-right">{c.read_count || 0}</td>
                        <td className="p-3 text-right">{rate}%</td>
                        <td className="p-3 text-muted-foreground whitespace-nowrap">
                          {c.sent_at ? format(new Date(c.sent_at), "dd/MM/yy HH:mm", { locale: ptBR }) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
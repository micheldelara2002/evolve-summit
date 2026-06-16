/**
 * Tela de métricas reutilizável — funciona para escopo global e por evento.
 * Rotas:
 *   /notifications/metrics         (global)
 *   /events/:eventId/notifications/metrics  (evento)
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Bell, Users, BookOpen, MousePointerClick, TrendingUp } from "lucide-react";
import { format, subDays, isAfter } from "date-fns";
import { ptBR } from "date-fns/locale";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line } from "recharts";

const STATUS_LABELS = {
  draft: "Rascunho", scheduled: "Agendado", processing: "Processando",
  sent: "Enviado", partially_sent: "Parcial", canceled: "Cancelado", failed: "Falhou",
};
const STATUS_COLORS = {
  draft: "bg-muted text-muted-foreground", sent: "bg-green-100 text-green-700",
  scheduled: "bg-blue-100 text-blue-700", failed: "bg-red-100 text-red-700",
};

export default function NotificationMetrics() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const scopeType = eventId ? "event" : "global";
  const backPath = eventId ? `/events/${eventId}?tab=notificacoes` : "/notifications";

  const [periodDays, setPeriodDays] = useState("30");
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ["notification_campaigns_metrics", scopeType, eventId],
    queryFn: () => {
      const filter = { is_deleted: false, scope_type: scopeType };
      if (eventId) filter.scope_event_id = eventId;
      return base44.entities.NotificationCampaign.filter(filter);
    },
  });

  const { data: allRecipients = [] } = useQuery({
    queryKey: ["notification_recipients_metrics", scopeType, eventId],
    queryFn: async () => {
      const cIds = campaigns.map((c) => c.id);
      if (!cIds.length) return [];
      const all = await base44.entities.NotificationRecipient.list("-created_date", 500);
      return all.filter((r) => cIds.includes(r.campaign_id));
    },
    enabled: campaigns.length > 0,
  });

  const cutoff = subDays(new Date(), parseInt(periodDays));
  const filteredCampaigns = campaigns.filter((c) => {
    const date = c.sent_at || c.created_date;
    if (!isAfter(new Date(date), cutoff)) return false;
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    return true;
  });

  const sentCampaigns = filteredCampaigns.filter((c) => c.status === "sent" || c.status === "partially_sent");
  const totalRecipients = sentCampaigns.reduce((s, c) => s + (c.recipients_count || 0), 0);
  const totalRead = sentCampaigns.reduce((s, c) => s + (c.read_count || 0), 0);
  const totalClicks = allRecipients.filter((r) => r.clicked_at).length;
  const readRate = totalRecipients > 0 ? ((totalRead / totalRecipients) * 100).toFixed(1) : "0.0";

  // Series temporal por dia
  const dayMap = {};
  sentCampaigns.forEach((c) => {
    const day = format(new Date(c.sent_at || c.created_date), "dd/MM");
    if (!dayMap[day]) dayMap[day] = { day, enviadas: 0, lidas: 0 };
    dayMap[day].enviadas += c.recipients_count || 0;
    dayMap[day].lidas += c.read_count || 0;
  });
  const chartData = Object.values(dayMap).slice(-14);

  const kpis = [
    { label: "Campanhas Enviadas", value: sentCampaigns.length, icon: Bell, color: "text-primary" },
    { label: "Total Destinatários", value: totalRecipients, icon: Users, color: "text-secondary" },
    { label: "Total Lidas", value: totalRead, icon: BookOpen, color: "text-green-600" },
    { label: "Taxa de Leitura", value: `${readRate}%`, icon: TrendingUp, color: "text-accent" },
    { label: "Cliques CTA", value: totalClicks, icon: MousePointerClick, color: "text-purple-600" },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(backPath)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-display font-bold">Métricas de Notificações</h1>
          <p className="text-sm text-muted-foreground">
            {scopeType === "global" ? "Visão global da plataforma" : "Visão por evento"}
          </p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={periodDays} onValueChange={setPeriodDays}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Últimos 7 dias</SelectItem>
            <SelectItem value="30">Últimos 30 dias</SelectItem>
            <SelectItem value="90">Últimos 90 dias</SelectItem>
            <SelectItem value="365">Último ano</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            <SelectItem value="sent">Enviado</SelectItem>
            <SelectItem value="draft">Rascunho</SelectItem>
            <SelectItem value="scheduled">Agendado</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">{kpi.label}</p>
                  <p className={`text-2xl font-display font-bold mt-1 ${kpi.color}`}>{kpi.value}</p>
                </div>
                <kpi.icon className={`w-5 h-5 ${kpi.color} opacity-60`} />
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
              <CardTitle className="text-sm">Envios por dia</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={chartData}>
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="enviadas" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
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
                  <Line type="monotone" dataKey="lidas" stroke="hsl(var(--secondary))" strokeWidth={2} dot={false} />
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
                  <tr className="border-b border-border">
                    <th className="text-left p-3 font-medium text-muted-foreground">Título</th>
                    <th className="text-left p-3 font-medium text-muted-foreground">Status</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Dest.</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Lidas</th>
                    <th className="text-right p-3 font-medium text-muted-foreground">Taxa</th>
                    <th className="text-left p-3 font-medium text-muted-foreground">Envio</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCampaigns.map((c) => {
                    const rate = c.recipients_count > 0
                      ? ((c.read_count || 0) / c.recipients_count * 100).toFixed(0)
                      : 0;
                    return (
                      <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                        <td className="p-3 max-w-[200px] truncate font-medium">{c.title}</td>
                        <td className="p-3">
                          <Badge className={STATUS_COLORS[c.status] || "bg-muted text-muted-foreground"}>
                            {STATUS_LABELS[c.status] || c.status}
                          </Badge>
                        </td>
                        <td className="p-3 text-right">{c.recipients_count || 0}</td>
                        <td className="p-3 text-right">{c.read_count || 0}</td>
                        <td className="p-3 text-right">{rate}%</td>
                        <td className="p-3 text-muted-foreground">
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
/**
 * Componente reutilizável de Central de Notificações.
 * Funciona tanto no contexto global (/notifications) quanto por evento (/events/:id/notifications).
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bell, Plus, Send, Trash2, Search, BarChart2, Globe } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useNavigate } from "react-router-dom";
import CampaignForm from "./CampaignForm";
import { dispatchCampaign } from "@/lib/notificationService";
import { toast } from "sonner";
import { TypeIcon, PriorityBadge, getCardHighlightClasses } from "./NotificationIcons";

const STATUS_COLORS = {
  draft: "bg-muted text-muted-foreground",
  scheduled: "bg-blue-100 text-blue-700",
  processing: "bg-yellow-100 text-yellow-700",
  sent: "bg-green-100 text-green-700",
  partially_sent: "bg-orange-100 text-orange-700",
  canceled: "bg-red-100 text-red-700",
  failed: "bg-red-100 text-red-700",
};

const STATUS_LABELS = {
  draft: "Rascunho",
  scheduled: "Agendado",
  processing: "Processando",
  sent: "Enviado",
  partially_sent: "Parcial",
  canceled: "Cancelado",
  failed: "Falhou",
};

export default function NotificationsCenter({ scopeType = "global", scopeEventId = null, metricsPath }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [filterPriority, setFilterPriority] = useState("all");
  // Only used in global admin view
  const [filterEventId, setFilterEventId] = useState("all");

  const isAdmin = user?.role === "admin";
  const isGlobalView = scopeType === "global";

  // Decide quais campanhas buscar
  const queryKey = ["notification_campaigns", scopeType, scopeEventId, isAdmin ? "admin" : user?.id];

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      if (isAdmin && isGlobalView) {
        // Admin no contexto global: busca tudo (globais + todos os eventos)
        return base44.entities.NotificationCampaign.filter({ is_deleted: false });
      }
      const filter = { is_deleted: false, scope_type: scopeType };
      if (scopeEventId) filter.scope_event_id = scopeEventId;
      return base44.entities.NotificationCampaign.filter(filter);
    },
  });

  // Eventos para o combobox (apenas admin na visão global)
  const { data: events = [] } = useQuery({
    queryKey: ["events_for_notif_filter"],
    queryFn: () => base44.entities.Event.filter({ is_deleted: false }),
    enabled: isAdmin && isGlobalView,
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.NotificationCampaign.update(id, { is_deleted: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const sendMutation = useMutation({
    mutationFn: (campaign) => dispatchCampaign(campaign, user),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      // Invalidar sininho após envio
      queryClient.invalidateQueries({ queryKey: ["notification_inbox_unread"] });
      queryClient.invalidateQueries({ queryKey: ["notification_inbox"] });
      toast.success("Campanha enviada com sucesso!");
    },
    onError: (e) => toast.error("Erro ao enviar: " + e.message),
  });

  // Aplicar todos os filtros
  const filtered = campaigns
    .filter((c) => {
      if (search && !c.title?.toLowerCase().includes(search.toLowerCase()) && !c.message?.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterStatus !== "all" && c.status !== filterStatus) return false;
      if (filterType !== "all" && c.type !== filterType) return false;
      if (filterPriority !== "all" && c.priority !== filterPriority) return false;
      // Filtro de evento (só admin global)
      if (isAdmin && isGlobalView && filterEventId !== "all") {
        if (filterEventId === "global" && c.scope_type !== "global") return false;
        if (filterEventId !== "global" && c.scope_event_id !== filterEventId) return false;
      }
      return true;
    })
    // Ordenar por data de envio mais recente
    .sort((a, b) => new Date(b.sent_at || b.created_date) - new Date(a.sent_at || a.created_date));

  const handleFormClose = () => {
    setShowForm(false);
    setEditingCampaign(null);
    queryClient.invalidateQueries({ queryKey });
  };

  if (showForm || editingCampaign) {
    return (
      <CampaignForm
        campaign={editingCampaign}
        scopeType={scopeType}
        scopeEventId={scopeEventId}
        onClose={handleFormClose}
        currentUser={user}
      />
    );
  }

  const getEventName = (id) => events.find((e) => e.id === id)?.name;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Bell className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-display font-bold">
              {isGlobalView ? "Notificações Globais" : "Notificações do Evento"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isGlobalView ? "Campanhas para todos os usuários" : "Campanhas segmentadas por evento"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {metricsPath && (
            <Button variant="outline" size="sm" onClick={() => navigate(metricsPath)}>
              <BarChart2 className="w-4 h-4 mr-2" />
              Métricas
            </Button>
          )}
          <Button onClick={() => setShowForm(true)} size="sm">
            <Plus className="w-4 h-4 mr-2" />
            Nova Campanha
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar campanhas..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>

        {isAdmin && isGlobalView && (
          <Select value={filterEventId} onValueChange={setFilterEventId}>
            <SelectTrigger className="w-44 h-9"><SelectValue placeholder="Evento" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="global">Globais</SelectItem>
              {events.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select value={filterStatus} onValueChange={setFilterStatus}>
          <SelectTrigger className="w-36 h-9"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos status</SelectItem>
            <SelectItem value="draft">Rascunho</SelectItem>
            <SelectItem value="sent">Enviado</SelectItem>
            <SelectItem value="scheduled">Agendado</SelectItem>
            <SelectItem value="failed">Falhou</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="w-36 h-9"><SelectValue placeholder="Tipo" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos tipos</SelectItem>
            <SelectItem value="informativa">Informativa</SelectItem>
            <SelectItem value="lembrete">Lembrete</SelectItem>
            <SelectItem value="destaque">Destaque</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterPriority} onValueChange={setFilterPriority}>
          <SelectTrigger className="w-36 h-9"><SelectValue placeholder="Prioridade" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Toda prioridade</SelectItem>
            <SelectItem value="low">Baixa</SelectItem>
            <SelectItem value="normal">Normal</SelectItem>
            <SelectItem value="high">Alta</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Lista */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Carregando...</div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Bell className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
            <p className="text-muted-foreground">Nenhuma campanha encontrada</p>
            <Button className="mt-4" onClick={() => setShowForm(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Criar primeira campanha
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((campaign) => {
            const highlightClass = getCardHighlightClasses(campaign.type, campaign.priority);
            const eventName = campaign.scope_type === "event" ? getEventName(campaign.scope_event_id) : null;
            return (
              <Card key={campaign.id} className={`hover:shadow-md transition-shadow${highlightClass}`}>
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      {/* Scope chip */}
                      <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                        {campaign.scope_type === "global" ? (
                          <Badge variant="outline" className="text-xs gap-1 px-1.5 py-0 text-muted-foreground">
                            <Globe className="w-3 h-3" /> Global
                          </Badge>
                        ) : eventName ? (
                          <Badge variant="outline" className="text-xs px-1.5 py-0 text-muted-foreground">
                            {eventName}
                          </Badge>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <TypeIcon type={campaign.type} />
                        <CardTitle className="text-base">{campaign.title}</CardTitle>
                        <Badge className={STATUS_COLORS[campaign.status] || "bg-muted text-muted-foreground"}>
                          {STATUS_LABELS[campaign.status] || campaign.status}
                        </Badge>
                        <PriorityBadge priority={campaign.priority} />
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-2">{campaign.message}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {campaign.status === "draft" && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setEditingCampaign(campaign)}>
                            Editar
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => sendMutation.mutate(campaign)}
                            disabled={sendMutation.isPending}
                          >
                            <Send className="w-4 h-4 mr-1" />
                            Enviar
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => deleteMutation.mutate(campaign.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                    <span>Criado em {format(new Date(campaign.created_date), "dd/MM/yyyy HH:mm", { locale: ptBR })}</span>
                    {campaign.sent_at && (
                      <span>Enviado em {format(new Date(campaign.sent_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}</span>
                    )}
                    {campaign.recipients_count > 0 && (
                      <span>{campaign.recipients_count} destinatários · {campaign.read_count || 0} lidas</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
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
import { Bell, Plus, Send, Trash2, Search, BarChart2 } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { useNavigate } from "react-router-dom";
import CampaignForm from "./CampaignForm";
import { dispatchCampaign } from "@/lib/notificationService";
import { toast } from "sonner";

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

const TYPE_LABELS = {
  informativa: "Informativa",
  lembrete: "Lembrete",
  destaque: "Destaque",
};

export default function NotificationsCenter({ scopeType = "global", scopeEventId = null, metricsPath }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);

  const queryKey = ["notification_campaigns", scopeType, scopeEventId];

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey,
    queryFn: () => {
      const filter = { is_deleted: false, scope_type: scopeType };
      if (scopeEventId) filter.scope_event_id = scopeEventId;
      return base44.entities.NotificationCampaign.filter(filter);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.NotificationCampaign.update(id, { is_deleted: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const sendMutation = useMutation({
    mutationFn: (campaign) => dispatchCampaign(campaign, user),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success("Campanha enviada com sucesso!");
    },
    onError: (e) => toast.error("Erro ao enviar: " + e.message),
  });

  const filtered = campaigns.filter(
    (c) =>
      !search ||
      c.title?.toLowerCase().includes(search.toLowerCase()) ||
      c.message?.toLowerCase().includes(search.toLowerCase())
  );

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

  const isGlobal = scopeType === "global";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Bell className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-display font-bold">
              {isGlobal ? "Notificações Globais" : "Notificações do Evento"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isGlobal ? "Campanhas para todos os usuários" : "Campanhas segmentadas por evento"}
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

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar campanhas..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

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
          {filtered.map((campaign) => (
            <Card key={campaign.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <CardTitle className="text-base">{campaign.title}</CardTitle>
                      <Badge className={STATUS_COLORS[campaign.status] || "bg-muted text-muted-foreground"}>
                        {STATUS_LABELS[campaign.status] || campaign.status}
                      </Badge>
                      <Badge variant="outline">{TYPE_LABELS[campaign.type] || campaign.type}</Badge>
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
          ))}
        </div>
      )}
    </div>
  );
}
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Send } from "lucide-react";

export default function CampaignForm({ campaign, scopeType = "global", scopeEventId = null, onClose, currentUser }) {
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    title: campaign?.title || "",
    message: campaign?.message || "",
    type: campaign?.type || "informativa",
    priority: campaign?.priority || "normal",
    audience_type: campaign?.audience_type || "all",
    cta_label: campaign?.cta_label || "",
    cta_target: campaign?.cta_target || "",
  });

  const saveMutation = useMutation({
    mutationFn: (data) => {
      if (campaign?.id) {
        return base44.entities.NotificationCampaign.update(campaign.id, data);
      }
      return base44.entities.NotificationCampaign.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification_campaigns"] });
      onClose?.();
    },
  });

  const handleSubmit = (status = "draft") => {
    saveMutation.mutate({
      ...form,
      scope_type: scopeType,
      scope_event_id: scopeEventId || undefined,
      sender_user_id: currentUser?.id,
      sender_role: currentUser?.role,
      status,
      ...(status === "sent" ? { sent_at: new Date().toISOString() } : {}),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onClose}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h2 className="text-xl font-display font-bold">
          {campaign ? "Editar Campanha" : "Nova Campanha"}
        </h2>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Conteúdo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Título *</Label>
            <Input
              placeholder="Título da notificação (máx. 80 chars)"
              maxLength={80}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label>Mensagem *</Label>
            <Textarea
              placeholder="Mensagem da notificação (máx. 500 chars)"
              maxLength={500}
              rows={4}
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
            />
            <p className="text-xs text-muted-foreground text-right">{form.message.length}/500</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Tipo</Label>
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="informativa">Informativa</SelectItem>
                  <SelectItem value="lembrete">Lembrete</SelectItem>
                  <SelectItem value="destaque">Destaque</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Prioridade</Label>
              <Select value={form.priority} onValueChange={(v) => setForm({ ...form, priority: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Baixa</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">Alta</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Audiência</Label>
            <Select value={form.audience_type} onValueChange={(v) => setForm({ ...form, audience_type: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="segment">Segmento</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Botão CTA (label)</Label>
              <Input
                placeholder="Ex: Ver mais"
                value={form.cta_label}
                onChange={(e) => setForm({ ...form, cta_label: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Link CTA (rota ou URL)</Label>
              <Input
                placeholder="Ex: /events"
                value={form.cta_target}
                onChange={(e) => setForm({ ...form, cta_target: e.target.value })}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button
          variant="outline"
          onClick={() => handleSubmit("draft")}
          disabled={!form.title || !form.message || saveMutation.isPending}
        >
          Salvar Rascunho
        </Button>
        <Button
          onClick={() => handleSubmit("sent")}
          disabled={!form.title || !form.message || saveMutation.isPending}
        >
          <Send className="w-4 h-4 mr-2" />
          Enviar Agora
        </Button>
      </div>
    </div>
  );
}
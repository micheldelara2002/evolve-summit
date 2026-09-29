import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Send, CalendarClock } from "lucide-react";
import AudienceSelector from "./AudienceSelector";
import { dispatchCampaign } from "@/lib/notificationService";
import { isAdmin, isPartnerManager } from "@/lib/access";
import { sanitizeText } from "@/utils/sanitize";
import { toast } from "sonner";

export default function CampaignForm({ campaign, scopeType = "global", scopeEventId = null, onClose, currentUser, partnerId, isReadOnly }) {
  const queryClient = useQueryClient();

  // audience value: { type: "all"|"segment"|"my_leads"|"my_attendees", segments: [] }
  const parseInitialAudience = () => {
    if (!campaign) return { type: "all", segments: [] };
    if (campaign.audience_type === "segment") {
      try {
        const segs = campaign.audience_payload ? JSON.parse(campaign.audience_payload) : [];
        return { type: "segment", segments: segs };
      } catch { return { type: "segment", segments: [] }; }
    }
    return { type: campaign.audience_type || "all", segments: [] };
  };

  const [form, setForm] = useState({
    title: campaign?.title || "",
    message: campaign?.message || "",
    type: campaign?.type || "informativa",
    priority: campaign?.priority || "normal",
    cta_label: campaign?.cta_label || "",
    cta_target: campaign?.cta_target || "",
  });
  const [audience, setAudience] = useState(parseInitialAudience);

  // P2 — Agendamento: datetime-local ↔ ISO (input local, persistência UTC).
  const toLocalInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const [scheduledAt, setScheduledAt] = useState(() => toLocalInput(campaign?.scheduled_at));

  const saveDraftMutation = useMutation({
    mutationFn: (data) => {
      if (campaign?.id) return base44.entities.NotificationCampaign.update(campaign.id, data);
      return base44.entities.NotificationCampaign.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification_campaigns"] });
      toast.success("Rascunho salvo.");
      onClose?.();
    },
  });

  const sendMutation = useMutation({
    mutationFn: async (campaignData) => {
      let savedCampaign;
      if (campaign?.id) {
        await base44.entities.NotificationCampaign.update(campaign.id, campaignData);
        savedCampaign = { ...campaign, ...campaignData };
      } else {
        savedCampaign = await base44.entities.NotificationCampaign.create(campaignData);
      }
      await dispatchCampaign(savedCampaign, currentUser, partnerId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification_campaigns"] });
      toast.success("Campanha enviada com sucesso!");
      onClose?.();
    },
    onError: (e) => toast.error("Erro ao enviar: " + e.message),
  });

  // P2 — Agendar: permissão validada NO MOMENTO DO AGENDAMENTO (server-side,
  // mesma autorização do disparo — countCampaignAudience). A campanha fica
  // 'scheduled' e a varredura de manutenção dispara sozinha no scheduled_at.
  const scheduleMutation = useMutation({
    mutationFn: async () => {
      await base44.functions.invoke("countCampaignAudience", {
        scopeEventId: scopeEventId || null,
        audienceType: audience.type === "segment" ? "segment" : audience.type,
        audienceSegments: audience.type === "segment" ? audience.segments : [],
        senderPartnerId: partnerId || null,
      });
      const data = buildPayload("scheduled");
      data.scheduled_at = new Date(scheduledAt).toISOString();
      // Audiências de parceiro: o partner_id precisa ser persistido — o disparo
      // agendado roda em service role, sem o contexto do navegador.
      if (partnerId && ["my_leads", "partner_leads"].includes(audience.type)) {
        data.audience_payload = JSON.stringify({ partner_id: partnerId });
      }
      if (campaign?.id) return base44.entities.NotificationCampaign.update(campaign.id, data);
      return base44.entities.NotificationCampaign.create(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification_campaigns"] });
      toast.success("Campanha agendada! O envio dispara automaticamente na data — você não precisa ficar online.");
      onClose?.();
    },
    onError: (e) => toast.error("Erro ao agendar: " + (e.message || "")),
  });

  const handleSchedule = () => {
    if (!scheduledAt) {
      toast.error("Escolha a data e a hora do envio.");
      return;
    }
    if (new Date(scheduledAt).getTime() <= Date.now()) {
      toast.error("A data do agendamento deve ser futura.");
      return;
    }
    scheduleMutation.mutate();
  };

  const buildPayload = (status) => ({
    title: sanitizeText(form.title),
    message: sanitizeText(form.message),
    type: form.type,
    priority: form.priority,
    cta_label: form.cta_label ? sanitizeText(form.cta_label) : "",
    cta_target: form.cta_target ? sanitizeText(form.cta_target) : "",
    scope_type: scopeType,
    scope_event_id: scopeEventId || undefined,
    sender_user_id: currentUser?.id,
    sender_role: isAdmin(currentUser)
      ? "admin"
      : isPartnerManager(currentUser)
        ? "representante"
        : undefined,
    status,
    audience_type: audience.type === "segment" ? "segment" : audience.type,
    audience_payload: audience.type === "segment" ? JSON.stringify(audience.segments) : null,
  });

  const isValid = form.title.trim() && form.message.trim();
  const isPending = saveDraftMutation.isPending || sendMutation.isPending || scheduleMutation.isPending;

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
        <CardHeader><CardTitle className="text-base">Conteúdo</CardTitle></CardHeader>
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
            <AudienceSelector
              user={currentUser}
              scopeType={scopeType}
              scopeEventId={scopeEventId}
              value={audience}
              onChange={setAudience}
              partnerId={partnerId}
            />
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

      {/* P2 — Agendamento: disparo automático pela varredura de manutenção */}
      <div className="flex items-end gap-3">
        <div className="space-y-1 flex-1">
          <Label>Agendar envio</Label>
          <Input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            O envio dispara automaticamente na data escolhida — sem depender do seu navegador.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={handleSchedule}
          disabled={!isValid || isPending || isReadOnly}
        >
          <CalendarClock className="w-4 h-4 mr-2" />
          {scheduleMutation.isPending ? "Agendando..." : "Agendar"}
        </Button>
      </div>

      <div className="flex justify-end gap-3">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button
          variant="outline"
          onClick={() => saveDraftMutation.mutate(buildPayload("draft"))}
          disabled={!isValid || isPending || isReadOnly}
        >
          Salvar Rascunho
        </Button>
        <Button
          onClick={() => sendMutation.mutate(buildPayload("draft"))}
          disabled={!isValid || isPending || isReadOnly}
        >
          <Send className="w-4 h-4 mr-2" />
          {isPending ? "Enviando..." : "Enviar Agora"}
        </Button>
      </div>
    </div>
  );
}
/**
 * Modal de detalhe de notificação — registra leitura e clique de CTA.
 */
import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ExternalLink } from "lucide-react";
import { TypeIcon, PriorityBadge, TYPE_CONFIG } from "./NotificationIcons";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

const TYPE_LABELS = { informativa: "Informativa", lembrete: "Lembrete", destaque: "Destaque" };
const STATUS_LABELS = { sent: "Enviado", draft: "Rascunho", scheduled: "Agendado", processing: "Processando", failed: "Falhou" };

export default function NotificationDetailModal({ recipient, campaign, onClose }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const markReadMutation = useMutation({
    mutationFn: async (recipientId) => {
      // Fase 2 (2026-11-12) — a leitura é gravada sempre no servidor: o RLS de
      // NotificationRecipient.update passou a ser admin-only (antes o próprio
      // destinatário escrevia no registro e podia falsificar entrega/clique).
      // O backend ancora o registro ao usuário autenticado e faz o flip
      // condicional de read_at + incremento idempotente de read_count.
      await base44.functions.invoke("manageNotificationCampaign", {
        op: "mark_read",
        ...(campaign?.id ? { campaign_id: campaign.id } : { recipient_id: recipientId }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification_inbox"] });
      queryClient.invalidateQueries({ queryKey: ["notification_inbox_unread"] });
      queryClient.invalidateQueries({ queryKey: ["notification_campaigns"] });
    },
  });

  const markClickedMutation = useMutation({
    mutationFn: async (recipientId) => {
      // Fase 2 — clique também via backend (mesmo motivo do mark_read).
      await base44.functions.invoke("manageNotificationCampaign", {
        op: "mark_clicked",
        ...(campaign?.id ? { campaign_id: campaign.id } : { recipient_id: recipientId }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification_inbox"] });
    },
    onError: () => toast.error("Erro ao registrar clique."),
  });

  // Auto-marcar como lida ao abrir (idempotente)
  useEffect(() => {
    if (recipient && !recipient.read_at) {
      markReadMutation.mutate(recipient.id);
    }
  }, [recipient?.id]);

  if (!recipient || !campaign) return null;

  const handleCTA = () => {
    if (!recipient.clicked_at) {
      markClickedMutation.mutate(recipient.id);
    }
    if (campaign.cta_target) {
      if (campaign.cta_target.startsWith("http")) {
        window.open(campaign.cta_target, "_blank");
      } else {
        navigate(campaign.cta_target);
        onClose();
      }
    }
  };

  const typeLabel = TYPE_LABELS[campaign.type] || campaign.type;
  const typeIconClass = TYPE_CONFIG[campaign.type]?.iconClass || "";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <TypeIcon type={campaign.type} />
            <span className={`text-xs font-medium ${typeIconClass}`}>{typeLabel}</span>
            <PriorityBadge priority={campaign.priority} />
          </div>
          <DialogTitle className="text-lg font-display leading-tight">{campaign.title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-foreground leading-relaxed">{campaign.message}</p>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground border-t pt-3">
            {recipient.delivered_at && (
              <span>Recebida em {format(new Date(recipient.delivered_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}</span>
            )}
            {campaign.sent_at && (
              <span>Enviada em {format(new Date(campaign.sent_at), "dd/MM/yyyy HH:mm", { locale: ptBR })}</span>
            )}
          </div>

          {campaign.cta_label && campaign.cta_target && (
            <Button className="w-full gap-2" onClick={handleCTA}>
              {campaign.cta_target.startsWith("http") && <ExternalLink className="w-4 h-4" />}
              {campaign.cta_label}
            </Button>
          )}

          <Button variant="outline" className="w-full" onClick={onClose}>
            Fechar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
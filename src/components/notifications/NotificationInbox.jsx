import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Bell, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { TypeIcon, PriorityBadge, getCardHighlightClasses } from "./NotificationIcons";
import NotificationDetailModal from "./NotificationDetailModal";

export function useUnreadCount() {
  const { user } = useAuth();

  const { data: recipients = [] } = useQuery({
    queryKey: ["notification_inbox_unread", user?.id],
    queryFn: () =>
      user
        ? base44.entities.NotificationRecipient.filter({
            recipient_user_id: user.id,
            delivery_status: "sent",
          })
        : [],
    enabled: !!user,
    // Refresh a cada 30s para refletir novos envios
    refetchInterval: 30000,
  });

  return recipients.filter((r) => !r.read_at).length;
}

export default function NotificationInbox({ onClose }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedRecipient, setSelectedRecipient] = useState(null);
  const [selectedCampaign, setSelectedCampaign] = useState(null);

  const { data: recipients = [], isLoading } = useQuery({
    queryKey: ["notification_inbox", user?.id],
    queryFn: () =>
      user
        ? base44.entities.NotificationRecipient.filter({
            recipient_user_id: user.id,
            delivery_status: "sent",
          })
        : [],
    enabled: !!user,
    refetchInterval: 30000,
  });

  const campaignIds = [...new Set(recipients.map((r) => r.campaign_id))];

  const { data: campaigns = [] } = useQuery({
    queryKey: ["notification_inbox_campaigns", campaignIds.join(",")],
    queryFn: async () => {
      if (!campaignIds.length) return [];
      return base44.entities.NotificationCampaign.filter({ id: { $in: campaignIds } });
    },
    enabled: campaignIds.length > 0,
  });

  // Subscrever mudanças em tempo real
  useEffect(() => {
    if (!user) return;
    const unsub = base44.entities.NotificationRecipient.subscribe((event) => {
      if (
        event.data?.recipient_user_id === user.id ||
        event.type === "create"
      ) {
        queryClient.invalidateQueries({ queryKey: ["notification_inbox"] });
        queryClient.invalidateQueries({ queryKey: ["notification_inbox_unread"] });
      }
    });
    return unsub;
  }, [user?.id]);

  const getCampaign = (id) => campaigns.find((c) => c.id === id);

  const sorted = [...recipients].sort(
    (a, b) => new Date(b.created_date) - new Date(a.created_date)
  );

  const unreadCount = sorted.filter((r) => !r.read_at).length;

  const handleOpen = (recipient) => {
    const campaign = getCampaign(recipient.campaign_id);
    setSelectedRecipient(recipient);
    setSelectedCampaign(campaign);
  };

  return (
    <>
      <div className="flex flex-col max-h-[80vh] md:max-h-96">
        <div className="flex items-center justify-between p-4 border-b">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4" />
            <span className="font-semibold text-sm">Notificações</span>
            {unreadCount > 0 && (
              <Badge className="bg-destructive text-white text-xs px-1.5 py-0">{unreadCount}</Badge>
            )}
          </div>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 sm:h-6 sm:w-6 shrink-0"
              onClick={onClose}
              aria-label="Fechar notificações"
            >
              <X className="w-4 h-4 sm:w-3 sm:h-3" />
            </Button>
          )}
        </div>

        <div className="overflow-y-auto flex-1 pb-safe">
          {isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">Carregando...</div>
          ) : sorted.length === 0 ? (
            <div className="p-8 text-center">
              <Bell className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Sem notificações</p>
            </div>
          ) : (
            sorted.map((recipient) => {
              const campaign = getCampaign(recipient.campaign_id);
              const isUnread = !recipient.read_at;
              const highlightClass = campaign ? getCardHighlightClasses(campaign.type, campaign.priority) : "";
              return (
                <button
                  key={recipient.id}
                  type="button"
                  className={`w-full text-left flex gap-3 p-4 border-b last:border-0 hover:bg-muted/50 transition-colors cursor-pointer ${isUnread ? "bg-primary/5" : ""} ${highlightClass}`}
                  onClick={() => handleOpen(recipient)}
                >
                  <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${isUnread ? "bg-primary" : "bg-transparent"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                      {campaign && <TypeIcon type={campaign.type} className="w-3.5 h-3.5" />}
                      <p className={`text-sm font-medium ${isUnread ? "" : "text-muted-foreground"}`}>
                        {campaign?.title || "Notificação"}
                      </p>
                      {campaign && <PriorityBadge priority={campaign.priority} />}
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                      {campaign?.message}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {recipient.delivered_at
                        ? format(new Date(recipient.delivered_at), "dd/MM HH:mm", { locale: ptBR })
                        : ""}
                    </p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {selectedRecipient && selectedCampaign && (
        <NotificationDetailModal
          recipient={selectedRecipient}
          campaign={selectedCampaign}
          onClose={() => {
            setSelectedRecipient(null);
            setSelectedCampaign(null);
            // Refresh inbox após leitura
            queryClient.invalidateQueries({ queryKey: ["notification_inbox"] });
            queryClient.invalidateQueries({ queryKey: ["notification_inbox_unread"] });
          }}
        />
      )}
    </>
  );
}
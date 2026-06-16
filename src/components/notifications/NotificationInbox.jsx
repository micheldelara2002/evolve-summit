import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Bell, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

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
    refetchInterval: 60000,
  });

  return recipients.filter((r) => !r.read_at).length;
}

export default function NotificationInbox({ onClose }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

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
  });

  const campaignIds = [...new Set(recipients.map((r) => r.campaign_id))];

  const { data: campaigns = [] } = useQuery({
    queryKey: ["notification_inbox_campaigns", campaignIds.join(",")],
    queryFn: async () => {
      if (!campaignIds.length) return [];
      const all = await base44.entities.NotificationCampaign.list();
      return all.filter((c) => campaignIds.includes(c.id));
    },
    enabled: campaignIds.length > 0,
  });

  const markReadMutation = useMutation({
    mutationFn: (recipientId) =>
      base44.entities.NotificationRecipient.update(recipientId, {
        read_at: new Date().toISOString(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notification_inbox"] });
      queryClient.invalidateQueries({ queryKey: ["notification_inbox_unread"] });
    },
  });

  const getCampaign = (id) => campaigns.find((c) => c.id === id);

  const sorted = [...recipients].sort(
    (a, b) => new Date(b.created_date) - new Date(a.created_date)
  );

  const unreadCount = sorted.filter((r) => !r.read_at).length;

  return (
    <div className="flex flex-col max-h-96">
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4" />
          <span className="font-semibold text-sm">Notificações</span>
          {unreadCount > 0 && (
            <Badge className="bg-destructive text-white text-xs px-1.5 py-0">{unreadCount}</Badge>
          )}
        </div>
        {onClose && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="w-3 h-3" />
          </Button>
        )}
      </div>

      <div className="overflow-y-auto flex-1">
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
            return (
              <div
                key={recipient.id}
                className={`flex gap-3 p-4 border-b last:border-0 hover:bg-muted/50 transition-colors ${isUnread ? "bg-primary/5" : ""}`}
              >
                <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${isUnread ? "bg-primary" : "bg-transparent"}`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium ${isUnread ? "" : "text-muted-foreground"}`}>
                    {campaign?.title || "Notificação"}
                  </p>
                  <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                    {campaign?.message}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {recipient.delivered_at
                      ? format(new Date(recipient.delivered_at), "dd/MM HH:mm", { locale: ptBR })
                      : ""}
                  </p>
                </div>
                {isUnread && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => markReadMutation.mutate(recipient.id)}
                    title="Marcar como lida"
                  >
                    <Check className="w-3 h-3" />
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
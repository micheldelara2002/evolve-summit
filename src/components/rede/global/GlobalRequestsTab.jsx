import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Check, X, Loader2, Inbox, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PersonAvatar from "../PersonAvatar";
import EventBadge from "../EventBadge";
import ListSkeleton from "@/components/ui/ListSkeleton";
import { acceptConnectionRequest, refuseConnectionRequest, cancelConnectionRequest } from "@/lib/redeService";
import { toast } from "sonner";
import { t } from "@/lib/i18n";

const STATUS_LABEL_KEYS = { pending: "rede.pending", accepted: "rede.accepted", refused: "rede.refused", canceled: "rede.canceled" };
const STATUS_COLORS = {
  pending: "text-muted-foreground",
  accepted: "text-secondary",
  refused: "text-destructive",
  canceled: "text-muted-foreground",
};

export default function GlobalRequestsTab({ eventIds, eventMap, myPerson, myParticipantRecords }) {
  const queryClient = useQueryClient();
  const [actioningIds, setActioningIds] = useState(new Set());

  const { data: allRequests = [], isLoading } = useQuery({
    queryKey: ["rede_global_all_requests", myPerson.id, eventIds.join(",")],
    queryFn: async () => {
      const [sent, received] = await Promise.all([
        base44.entities.ConnectionRequest.filter({ requester_person_id: myPerson.id, is_deleted: false }),
        base44.entities.ConnectionRequest.filter({ receiver_person_id: myPerson.id, is_deleted: false }),
      ]);
      const seen = new Set();
      const merged = [...sent, ...received].filter((r) => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      });
      return merged.filter((r) => eventIds.includes(r.event_id));
    },
  });

  const requestPersonIds = [...new Set(
    allRequests.flatMap((r) => [r.requester_person_id, r.receiver_person_id]).filter(Boolean)
  )];
  const { data: persons = [] } = useQuery({
    queryKey: ["rede_persons_by_global_requests", requestPersonIds.join(",")],
    queryFn: async () => {
      if (!requestPersonIds.length) return [];
      return base44.entities.Person.filter({ id: { $in: requestPersonIds }, is_active: true });
    },
    enabled: requestPersonIds.length > 0,
  });
  const personMap = new Map(persons.map((p) => [p.id, p]));

  const received = allRequests.filter((r) => r.receiver_person_id === myPerson.id && r.status === "pending");
  const sent = allRequests.filter((r) => r.requester_person_id === myPerson.id);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["rede_global_all_requests"] });
    queryClient.invalidateQueries({ queryKey: ["rede_global_connections"] });
    queryClient.invalidateQueries({ queryKey: ["rede_global_sent_requests"] });
  };

  const setActioning = (id, val) => {
    setActioningIds((prev) => {
      const n = new Set(prev);
      if (val) n.add(id); else n.delete(id);
      return n;
    });
  };

  const handleAccept = async (request) => {
    setActioning(request.id, true);
    try {
      const myPart = myParticipantRecords.find((p) => p.event_id === request.event_id);
      await acceptConnectionRequest({ request, eventId: request.event_id, accepterPerson: myPerson, accepterParticipantId: myPart?.id });
      toast.success(t("rede.accepted"));
      invalidate();
    } catch (e) {
      toast.error(t("rede.requestSendError") + ": " + e.message);
    } finally {
      setActioning(request.id, false);
    }
  };

  const handleRefuse = async (request) => {
    setActioning(request.id, true);
    try {
      await refuseConnectionRequest({ requestId: request.id });
      toast.info(t("rede.refused"));
      invalidate();
    } catch (e) {
      toast.error(t("rede.requestSendError") + ": " + e.message);
    } finally {
      setActioning(request.id, false);
    }
  };

  const handleCancel = async (request) => {
    setActioning(request.id, true);
    try {
      await cancelConnectionRequest({ requestId: request.id });
      toast.info(t("rede.canceled"));
      invalidate();
    } catch (e) {
      toast.error(t("rede.requestSendError") + ": " + e.message);
    } finally {
      setActioning(request.id, false);
    }
  };

  if (isLoading) return <ListSkeleton count={3} />;

  return (
    <div className="space-y-6">
      {/* Recebidos */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Inbox className="w-4 h-4" /> {t("rede.receivedRequests")}
          {received.length > 0 && <Badge variant="secondary" className="ml-1">{received.length}</Badge>}
        </h3>
        {received.length === 0 ? (
          <p className="text-sm text-muted-foreground pl-6">{t("rede.noReceivedRequests")}</p>
        ) : (
          received.map((req) => {
            const person = personMap.get(req.requester_person_id);
            const isActioning = actioningIds.has(req.id);
            return (
              <div key={req.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
                <PersonAvatar person={person} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{req.requester_name}</p>
                  <EventBadge eventName={eventMap.get(req.event_id)?.name} />
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Button size="sm" disabled={isActioning} onClick={() => handleAccept(req)}>
                    {isActioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    {t("rede.accept")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={isActioning} onClick={() => handleRefuse(req)}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Enviados */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Send className="w-4 h-4" /> {t("rede.sentRequests")}
        </h3>
        {sent.length === 0 ? (
          <p className="text-sm text-muted-foreground pl-6">{t("rede.noSentRequests")}</p>
        ) : (
          sent.map((req) => {
            const person = personMap.get(req.receiver_person_id);
            const isActioning = actioningIds.has(req.id);
            return (
              <div key={req.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
                <PersonAvatar person={person} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{req.receiver_name}</p>
                  <EventBadge eventName={eventMap.get(req.event_id)?.name} />
                </div>
                {req.status === "pending" ? (
                  <Button size="sm" variant="ghost" disabled={isActioning} onClick={() => handleCancel(req)}>
                    {isActioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                    {t("rede.cancel")}
                  </Button>
                ) : (
                  <span className={`text-xs font-medium shrink-0 ${STATUS_COLORS[req.status]}`}>
                    {t(STATUS_LABEL_KEYS[req.status])}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { MessageSquare, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import PersonAvatar from "../PersonAvatar";
import EventBadge from "../EventBadge";
import ListSkeleton from "@/components/ui/ListSkeleton";
import EmptyState from "@/components/ui/EmptyState";
import { getOrCreateThread } from "@/lib/redeService";
import { toast } from "sonner";
import { t } from "@/lib/i18n";

export default function GlobalConnectionsTab({ eventIds, eventMap, myPerson, myParticipantRecords, onStartChat }) {
  const [pendingIds, setPendingIds] = useState(new Set());

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ["rede_global_connections", myPerson.id, eventIds.join(",")],
    queryFn: async () => {
      const [asA, asB] = await Promise.all([
        base44.entities.Connection.filter({ person_a_id: myPerson.id, is_deleted: false }),
        base44.entities.Connection.filter({ person_b_id: myPerson.id, is_deleted: false }),
      ]);
      const seen = new Set();
      const merged = [...asA, ...asB].filter((c) => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      });
      return merged.filter((c) => eventIds.includes(c.event_id));
    },
  });

  const connectionPersonIds = [...new Set(
    connections.flatMap((c) => [c.person_a_id, c.person_b_id]).filter((id) => id !== myPerson.id)
  )];
  const { data: persons = [] } = useQuery({
    queryKey: ["rede_persons_by_global_connections", connectionPersonIds.join(",")],
    queryFn: async () => {
      if (!connectionPersonIds.length) return [];
      return base44.entities.Person.filter({ id: { $in: connectionPersonIds }, is_active: true });
    },
    enabled: connectionPersonIds.length > 0,
  });
  const personMap = new Map(persons.map((p) => [p.id, p]));

  const handleStartChat = async (conn) => {
    const otherId = conn.person_a_id === myPerson.id ? conn.person_b_id : conn.person_a_id;
    const otherName = conn.person_a_id === myPerson.id ? conn.person_b_name : conn.person_a_name;
    setPendingIds((prev) => new Set(prev).add(otherId));
    try {
      const thread = await getOrCreateThread({
        eventId: conn.event_id,
        myPersonId: myPerson.id,
        myPersonName: myPerson.full_name,
        otherPersonId: otherId,
        otherPersonName: otherName,
      });
      onStartChat(thread.id);
    } catch (e) {
      toast.error(t("rede.requestSendError") + ": " + e.message);
    } finally {
      setPendingIds((prev) => { const n = new Set(prev); n.delete(otherId); return n; });
    }
  };

  if (isLoading) return <ListSkeleton count={4} />;

  if (connections.length === 0) {
    return <EmptyState icon={Users} title={t("rede.noConnections")} description={t("rede.noConnectionsDesc")} />;
  }

  return (
    <div className="grid gap-2">
      {connections.map((conn) => {
        const otherId = conn.person_a_id === myPerson.id ? conn.person_b_id : conn.person_a_id;
        const otherName = conn.person_a_id === myPerson.id ? conn.person_b_name : conn.person_a_name;
        const person = personMap.get(otherId);
        const isPending = pendingIds.has(otherId);
        return (
          <div key={conn.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
            <PersonAvatar person={person || { full_name: otherName }} />
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm truncate">{otherName}</p>
              <EventBadge eventName={eventMap.get(conn.event_id)?.name} />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() => handleStartChat(conn)}
              className="shrink-0"
            >
              {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
              {t("rede.chat")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { MessageSquare, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import PersonAvatar from "./PersonAvatar";
import { getOrCreateThread } from "@/lib/redeService";
import { toast } from "sonner";

export default function ConnectionsTab({ eventId, myPerson, isReadOnly, onStartChat }) {
  const [pendingIds, setPendingIds] = useState(new Set());

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ["rede_connections", eventId, myPerson.id],
    queryFn: async () => {
      const [asA, asB] = await Promise.all([
        base44.entities.Connection.filter({ event_id: eventId, person_a_id: myPerson.id, is_deleted: false }),
        base44.entities.Connection.filter({ event_id: eventId, person_b_id: myPerson.id, is_deleted: false }),
      ]);
      return [...asA, ...asB];
    },
  });

  // Load only Persons who appear in the user's connections
  const connectionPersonIds = [...new Set(
    connections.flatMap((c) => [c.person_a_id, c.person_b_id]).filter((id) => id !== myPerson.id)
  )];
  const { data: persons = [] } = useQuery({
    queryKey: ["rede_persons_by_connections", eventId, connectionPersonIds.join(",")],
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
        eventId,
        myPersonId: myPerson.id,
        myPersonName: myPerson.full_name,
        otherPersonId: otherId,
        otherPersonName: otherName,
      });
      onStartChat(thread.id);
    } catch (e) {
      toast.error("Erro ao iniciar conversa: " + e.message);
    } finally {
      setPendingIds((prev) => { const n = new Set(prev); n.delete(otherId); return n; });
    }
  };

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  if (connections.length === 0) {
    return (
      <div className="text-center py-12 space-y-2">
        <Users className="w-10 h-10 mx-auto text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">Você ainda não tem conexões neste evento.</p>
      </div>
    );
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
            <span className="font-medium text-sm flex-1 truncate">{otherName}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={isReadOnly || isPending}
              onClick={() => handleStartChat(conn)}
            >
              {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
              Conversar
            </Button>
          </div>
        );
      })}
    </div>
  );
}
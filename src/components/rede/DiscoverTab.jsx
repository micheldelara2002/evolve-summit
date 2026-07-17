import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Search, UserPlus, Check, Loader2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import PersonAvatar from "./PersonAvatar";
import { sendConnectionRequest } from "@/lib/redeService";
import { toast } from "sonner";

export default function DiscoverTab({ eventId, myPerson, isReadOnly }) {
  const [search, setSearch] = useState("");
  const [pendingIds, setPendingIds] = useState(new Set());
  const queryClient = useQueryClient();

  const { data: participants = [], isLoading } = useQuery({
    queryKey: ["rede_participants", eventId],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
  });

  // Load only Persons who are participants in this event (privacy + performance)
  const participantPersonIds = participants.map((p) => p.person_id).filter(Boolean);
  const { data: persons = [] } = useQuery({
    queryKey: ["rede_persons_by_event", eventId, participantPersonIds.join(",")],
    queryFn: async () => {
      if (!participantPersonIds.length) return [];
      return base44.entities.Person.filter({ id: { $in: participantPersonIds }, is_active: true });
    },
    enabled: participantPersonIds.length > 0,
  });

  const { data: mySentRequests = [] } = useQuery({
    queryKey: ["rede_sent_requests", eventId, myPerson.id],
    queryFn: () => base44.entities.ConnectionRequest.filter({ event_id: eventId, requester_person_id: myPerson.id, is_deleted: false }),
  });

  const { data: myConnections = [] } = useQuery({
    queryKey: ["rede_connections", eventId, myPerson.id],
    queryFn: async () => {
      const [asA, asB] = await Promise.all([
        base44.entities.Connection.filter({ event_id: eventId, person_a_id: myPerson.id, is_deleted: false }),
        base44.entities.Connection.filter({ event_id: eventId, person_b_id: myPerson.id, is_deleted: false }),
      ]);
      return [...asA, ...asB];
    },
  });

  const connectedIds = new Set(
    myConnections.flatMap((c) => [c.person_a_id, c.person_b_id]).filter((id) => id !== myPerson.id)
  );
  const sentIds = new Set(mySentRequests.filter((r) => r.status === "pending").map((r) => r.receiver_person_id));

  const personMap = new Map(persons.map((p) => [p.id, p]));
  const eligible = participants
    .filter((p) => p.person_id && p.person_id !== myPerson.id)
    .map((p) => personMap.get(p.person_id))
    .filter(Boolean);

  const filtered = eligible.filter((p) => !search || p.full_name?.toLowerCase().includes(search.toLowerCase()));

  const handleConnect = async (person) => {
    setPendingIds((prev) => new Set(prev).add(person.id));
    try {
      const myParticipant = participants.find((p) => p.person_id === myPerson.id);
      const result = await sendConnectionRequest({
        eventId,
        requesterPerson: myPerson,
        receiverPerson: person,
        requesterParticipantId: myParticipant?.id,
      });
      if (result.ok) {
        toast.success(result.reason === "auto_accepted" ? "Conexão aceita!" : "Pedido enviado!");
        queryClient.invalidateQueries({ queryKey: ["rede_sent_requests"] });
        queryClient.invalidateQueries({ queryKey: ["rede_connections"] });
        queryClient.invalidateQueries({ queryKey: ["rede_all_requests"] });
      } else {
        toast.info(
          result.reason === "already_connected" ? "Vocês já estão conectados" :
          result.reason === "already_pending" ? "Já existe um pedido pendente" :
          "Não foi possível enviar o pedido"
        );
      }
    } catch (e) {
      toast.error("Erro ao enviar pedido: " + e.message);
    } finally {
      setPendingIds((prev) => { const n = new Set(prev); n.delete(person.id); return n; });
    }
  };

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar pessoas por nome..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <Users className="w-10 h-10 mx-auto text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            {search ? "Nenhuma pessoa encontrada." : "Nenhuma pessoa disponível para conexão."}
          </p>
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((person) => {
            const isConnected = connectedIds.has(person.id);
            const isSent = sentIds.has(person.id);
            const isPending = pendingIds.has(person.id);
            return (
              <div key={person.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
                <PersonAvatar person={person} />
                <span className="font-medium text-sm flex-1 truncate">{person.full_name}</span>
                {isConnected ? (
                  <span className="flex items-center gap-1 text-xs text-secondary font-medium">
                    <Check className="w-3.5 h-3.5" /> Conectado
                  </span>
                ) : isSent ? (
                  <span className="text-xs text-muted-foreground">Pedido enviado</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={isReadOnly || isPending}
                    onClick={() => handleConnect(person)}
                  >
                    {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
                    Conectar
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Check, X, Loader2, Inbox, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PersonAvatar from "./PersonAvatar";
import { acceptConnectionRequest, refuseConnectionRequest, cancelConnectionRequest } from "@/lib/redeService";
import { toast } from "sonner";

export default function RequestsTab({ eventId, myPerson, myParticipant, user, isReadOnly }) {
  const queryClient = useQueryClient();
  const [actioningIds, setActioningIds] = useState(new Set());

  const { data: allRequests = [], isLoading } = useQuery({
    queryKey: ["rede_all_requests", eventId, myPerson.id],
    queryFn: async () => {
      const [sent, received] = await Promise.all([
        base44.entities.ConnectionRequest.filter({ event_id: eventId, requester_person_id: myPerson.id, is_deleted: false }),
        base44.entities.ConnectionRequest.filter({ event_id: eventId, receiver_person_id: myPerson.id, is_deleted: false }),
      ]);
      return [...sent, ...received];
    },
  });

  // Load only Persons who appear in requests
  const requestPersonIds = [...new Set(
    allRequests.flatMap((r) => [r.requester_person_id, r.receiver_person_id]).filter(Boolean)
  )];
  const { data: persons = [] } = useQuery({
    queryKey: ["rede_persons_by_requests", eventId, requestPersonIds.join(",")],
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
    queryClient.invalidateQueries({ queryKey: ["rede_all_requests"] });
    queryClient.invalidateQueries({ queryKey: ["rede_connections"] });
    queryClient.invalidateQueries({ queryKey: ["rede_sent_requests"] });
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
      await acceptConnectionRequest({ request, eventId, accepterPerson: myPerson, accepterParticipantId: myParticipant?.id });
      toast.success("Conexão aceita!");
      invalidate();
    } catch (e) {
      toast.error("Erro ao aceitar: " + e.message);
    } finally {
      setActioning(request.id, false);
    }
  };

  const handleRefuse = async (request) => {
    setActioning(request.id, true);
    try {
      await refuseConnectionRequest({ requestId: request.id, myPersonId: myPerson.id });
      toast.info("Pedido recusado.");
      invalidate();
    } catch (e) {
      toast.error("Erro ao recusar: " + e.message);
    } finally {
      setActioning(request.id, false);
    }
  };

  const handleCancel = async (request) => {
    setActioning(request.id, true);
    try {
      await cancelConnectionRequest({ requestId: request.id, myPersonId: myPerson.id });
      toast.info("Pedido cancelado.");
      invalidate();
    } catch (e) {
      toast.error("Erro ao cancelar: " + e.message);
    } finally {
      setActioning(request.id, false);
    }
  };

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Recebidos */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <Inbox className="w-4 h-4" /> Pedidos recebidos
          {received.length > 0 && <Badge variant="secondary" className="ml-1">{received.length}</Badge>}
        </h3>
        {received.length === 0 ? (
          <p className="text-sm text-muted-foreground pl-6">Nenhum pedido recebido.</p>
        ) : (
          received.map((req) => {
            const person = personMap.get(req.requester_person_id);
            const isActioning = actioningIds.has(req.id);
            return (
              <div key={req.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
                <PersonAvatar person={person} />
                <span className="font-medium text-sm flex-1 truncate">{req.requester_name}</span>
                <div className="flex gap-1.5">
                  <Button size="sm" disabled={isReadOnly || isActioning} onClick={() => handleAccept(req)}>
                    {isActioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    Aceitar
                  </Button>
                  <Button size="sm" variant="outline" disabled={isReadOnly || isActioning} onClick={() => handleRefuse(req)}>
                    <X className="w-3.5 h-3.5" />
                    Recusar
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
          <Send className="w-4 h-4" /> Pedidos enviados
        </h3>
        {sent.length === 0 ? (
          <p className="text-sm text-muted-foreground pl-6">Nenhum pedido enviado.</p>
        ) : (
          sent.map((req) => {
            const person = personMap.get(req.receiver_person_id);
            const isActioning = actioningIds.has(req.id);
            const statusLabel = { pending: "Pendente", accepted: "Aceito", refused: "Recusado", canceled: "Cancelado" }[req.status];
            const statusColor = { pending: "text-muted-foreground", accepted: "text-secondary", refused: "text-destructive", canceled: "text-muted-foreground" }[req.status];
            return (
              <div key={req.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
                <PersonAvatar person={person} />
                <span className="font-medium text-sm flex-1 truncate">{req.receiver_name}</span>
                {req.status === "pending" ? (
                  <Button size="sm" variant="ghost" disabled={isReadOnly || isActioning} onClick={() => handleCancel(req)}>
                    {isActioning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                    Cancelar
                  </Button>
                ) : (
                  <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
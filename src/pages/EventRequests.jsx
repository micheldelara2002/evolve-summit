import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { isAdmin } from "@/lib/access";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/layout/PageHeader";
import EmptyState from "@/components/ui/EmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import EventRequestCard from "@/components/events/EventRequestCard";
import EventRequestFormDialog from "@/components/events/EventRequestFormDialog";
import EventRequestReviewDialog from "@/components/events/EventRequestReviewDialog";
import { CalendarPlus, Inbox } from "lucide-react";
import { toast } from "sonner";

const FILTERS = [
  { value: "pending", label: "Pendentes" },
  { value: "all", label: "Todas" },
];

export default function EventRequests() {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("pending");
  const [creating, setCreating] = useState(false);
  const [review, setReview] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ["event_requests", admin ? "admin" : user?.id],
    queryFn: async () => {
      const res = await base44.functions.invoke("manageEventRequest", { action: "list" });
      return res.data?.requests || [];
    },
    enabled: !!user,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["event_requests"] });
    if (admin) queryClient.invalidateQueries({ queryKey: ["events"] });
  };

  const visible = filter === "pending"
    ? requests.filter((r) => r.status === "pending")
    : requests;

  const handleCancel = async (request) => {
    setBusyId(request.id);
    try {
      const res = await base44.functions.invoke("manageEventRequest", {
        action: "cancel",
        requestId: request.id,
      });
      if (res.data?.error) throw new Error(res.data.error);
      toast.success("Solicitação cancelada.");
      refresh();
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={admin ? Inbox : CalendarPlus}
        title={admin ? "Solicitações de Evento" : "Solicitar Evento"}
        subtitle={admin
          ? "Cada evento aprovado entra como fonte de receita — a aprovação é sua."
          : "Peça a criação do evento; o administrador aprova e o acesso de gerente é seu."}
        tone={admin ? "primary" : "secondary"}
        actions={!admin ? (
          <Button className="gap-1.5" onClick={() => setCreating(true)}>
            <CalendarPlus className="w-4 h-4" /> Nova solicitação
          </Button>
        ) : undefined}
      />

      <div className="flex gap-1">
        {FILTERS.map((opt) => (
          <Button
            key={opt.value}
            size="sm"
            variant={filter === opt.value ? "default" : "outline"}
            onClick={() => setFilter(opt.value)}
          >
            {opt.label}
          </Button>
        ))}
      </div>

      {isLoading && <ListSkeleton count={3} />}

      {!isLoading && visible.length === 0 && (
        <EmptyState
          icon={admin ? Inbox : CalendarPlus}
          title={admin ? "Nenhuma solicitação pendente" : "Você ainda não solicitou eventos"}
          description={admin
            ? "Quando um gerente pedir um novo evento, ele aparece aqui para a sua análise."
            : "Envie a proposta com os dados iniciais e o e-mail de quem vai gerir."}
        />
      )}

      <div className="grid gap-3">
        {visible.map((request) => (
          <EventRequestCard
            key={request.id}
            request={request}
            isAdmin={admin}
            busy={busyId === request.id}
            onApprove={(r) => setReview({ request: r, mode: "approve" })}
            onReject={(r) => setReview({ request: r, mode: "reject" })}
            onCancel={handleCancel}
          />
        ))}
      </div>

      {creating && (
        <EventRequestFormDialog
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); refresh(); }}
        />
      )}

      {review && (
        <EventRequestReviewDialog
          request={review.request}
          mode={review.mode}
          onClose={() => setReview(null)}
          onDone={() => { setReview(null); refresh(); }}
        />
      )}
    </div>
  );
}
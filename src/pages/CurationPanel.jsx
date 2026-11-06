/**
 * Painel de Curadoria — fila de submissões de Call for Papers dos eventos em que
 * a pessoa é curadora. A decisão (aprovar, reprovar, espera, cancelar) é feita
 * no servidor por manageSubmission, que valida o papel no evento.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/layout/PageHeader";
import EmptyState from "@/components/ui/EmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import SubmissionsReview from "@/components/admin/cfp/SubmissionsReview";
import { listReviewQueue } from "@/lib/submissionApi";
import { useAuth } from "@/lib/AuthContext";
import { cn } from "@/lib/utils";
import { Gavel } from "lucide-react";

export default function CurationPanel() {
  const { user } = useAuth();
  const [eventId, setEventId] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["curation-events", user?.id],
    queryFn: () => listReviewQueue(),
    enabled: !!user?.id,
  });

  const events = data?.events || [];
  const totalSubmissions = (data?.submissions || []).length;

  if (isLoading) return <ListSkeleton count={3} />;

  if (events.length === 0) {
    return (
      <EmptyState
        icon={Gavel}
        title="Nenhuma curadoria atribuída"
        description="Quando o gerente de um evento te designar como curador, as submissões aparecerão aqui."
      />
    );
  }

  const selected = eventId || events[0].id;
  const selectedEvent = events.find((e) => e.id === selected);

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <PageHeader
        icon={Gavel}
        title="Curadoria"
        subtitle={`${totalSubmissions} submissão(ões) em ${events.length} evento(s)`}
        tone="secondary"
      />

      {events.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {events.map((event) => (
            <button
              key={event.id}
              onClick={() => setEventId(event.id)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                selected === event.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground"
              )}
            >
              {event.name}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <h2 className="text-base font-display font-semibold">{selectedEvent?.name || "Evento"}</h2>
        <SubmissionsReview key={selected} eventId={selected} hasAccess user={user} />
      </div>
    </div>
  );
}
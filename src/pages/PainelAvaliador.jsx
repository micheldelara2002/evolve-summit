import { useQuery } from "@tanstack/react-query";
import { Award, Trophy } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import { getMyMemberships, getEventIdsForRole, hasRole } from "@/lib/roleEngine";
import { isAdmin } from "@/lib/access";
import PageHeader from "@/components/layout/PageHeader";
import EmptyState from "@/components/ui/EmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";

/**
 * Painel do Avaliador (comissão de premiação).
 * Acessível por usuários com EventMembership role='reviewer' (ou admin).
 * Placeholder — o módulo de premiação será construído na sequência.
 */
export default function PainelAvaliador() {
  const { user } = useAuth();
  const admin = isAdmin(user);

  const { data: memberships, isLoading } = useQuery({
    queryKey: ["my-memberships", user?.id],
    queryFn: () => getMyMemberships(user?.id),
    enabled: !!user?.id,
  });

  const isReviewer = admin || hasRole(memberships, "reviewer");
  const reviewerEventIds = getEventIdsForRole(memberships || [], "reviewer");

  const { data: events } = useQuery({
    queryKey: ["reviewer-events", reviewerEventIds.join(",")],
    queryFn: async () => {
      if (!reviewerEventIds.length) return [];
      const all = await base44.entities.Event.list();
      return all.filter((e) => reviewerEventIds.includes(e.id));
    },
    enabled: reviewerEventIds.length > 0,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Award} title="Painel do Avaliador" tone="success" />
        <ListSkeleton count={3} />
      </div>
    );
  }

  if (!isReviewer) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Award} title="Painel do Avaliador" tone="success" />
        <EmptyState
          icon={Trophy}
          title="Você não faz parte de nenhuma comissão de avaliação"
          description="Quando um gestor te atribuir o papel de avaliador em um evento, suas premiações aparecerão aqui."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Award}
        title="Painel do Avaliador"
        subtitle="Comissão de premiação"
        tone="success"
      />

      {(!events || events.length === 0) && admin && (
        <EmptyState
          icon={Trophy}
          title="Módulo de premiação em preparação"
          description="Atribua o papel de avaliador às pessoas do seu evento para liberar o acesso às avaliações."
        />
      )}

      {events && events.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Eventos sob sua avaliação
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {events.map((event) => (
              <div
                key={event.id}
                className="rounded-xl border border-border bg-card p-4 space-y-1"
              >
                <p className="font-display font-semibold">{event.name}</p>
                <p className="text-xs text-muted-foreground">
                  {event.start_date ? new Date(event.start_date).toLocaleDateString("pt-BR") : "Data a definir"}
                </p>
                <p className="text-xs text-success font-medium pt-1">
                  Módulo de premiação em breve
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
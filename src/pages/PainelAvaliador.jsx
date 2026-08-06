import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, Trophy } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import { getMyMemberships, getEventIdsForRole, hasRole } from "@/lib/roleEngine";
import { isAdmin } from "@/lib/access";
import PageHeader from "@/components/layout/PageHeader";
import EmptyState from "@/components/ui/EmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import NominationList from "@/components/avaliador/NominationList";

export default function PainelAvaliador() {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const qc = useQueryClient();
  const [activeEventId, setActiveEventId] = useState(null);

  const membershipsQuery = useQuery({
    queryKey: ["my-memberships", user?.id],
    queryFn: () => getMyMemberships(user?.id),
    enabled: !!user?.id,
  });

  const isReviewer = admin || hasRole(membershipsQuery.data, "reviewer");
  const reviewerEventIds = getEventIdsForRole(membershipsQuery.data || [], "reviewer");

  const eventsQuery = useQuery({
    queryKey: ["reviewer-events", reviewerEventIds.join(",")],
    queryFn: async () => {
      if (!reviewerEventIds.length) return [];
      const all = await base44.entities.Event.list();
      return all.filter((e) => reviewerEventIds.includes(e.id));
    },
    enabled: reviewerEventIds.length > 0,
  });

  const eventId = activeEventId || reviewerEventIds[0];

  const categoriesQuery = useQuery({
    queryKey: ["award-categories", eventId],
    queryFn: () => base44.entities.AwardCategory.filter({ event_id: eventId, is_active: true, is_deleted: false }),
    enabled: !!eventId,
  });
  const nominationsQuery = useQuery({
    queryKey: ["award-nominations", eventId],
    queryFn: () => base44.entities.AwardNomination.filter({ event_id: eventId, is_deleted: false }),
    enabled: !!eventId,
  });
  const myEvalsQuery = useQuery({
    queryKey: ["my-evaluations", eventId, user?.id],
    queryFn: () => base44.entities.AwardEvaluation.filter({ event_id: eventId, is_deleted: false }),
    enabled: !!eventId && !!user?.id,
  });

  if (membershipsQuery.isLoading) {
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
        <EmptyState icon={Trophy} title="Você não faz parte de nenhuma comissão" description="Quando um gestor te atribuir o papel de avaliador, suas premiações aparecerão aqui." />
      </div>
    );
  }

  const events = eventsQuery.data || [];
  const invalidateEvals = () => qc.invalidateQueries({ queryKey: ["my-evaluations", eventId, user?.id] });

  return (
    <div className="space-y-6">
      <PageHeader icon={Award} title="Painel do Avaliador" subtitle="Comissão de premiação" tone="success" />

      {events.length > 1 && (
        <div className="flex gap-2 flex-wrap">
          {events.map((e) => (
            <button
              key={e.id}
              onClick={() => setActiveEventId(e.id)}
              className={`px-3 py-1.5 rounded-full text-sm border transition ${eventId === e.id ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border"}`}
            >
              {e.name}
            </button>
          ))}
        </div>
      )}

      {events.length === 0 ? (
        <EmptyState icon={Trophy} title="Nenhum evento com premiação ativa" description="Aguarde o gestor configurar categorias e indicações no evento." />
      ) : categoriesQuery.isLoading ? (
        <ListSkeleton count={3} />
      ) : (
        <NominationList
          categories={categoriesQuery.data || []}
          nominations={nominationsQuery.data || []}
          myEvaluations={myEvalsQuery.data || []}
          onEvaluated={invalidateEvals}
        />
      )}
    </div>
  );
}
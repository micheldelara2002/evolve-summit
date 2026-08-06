import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Award, Trophy } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { getMyMemberships, hasRole } from "@/lib/roleEngine";
import { isAdmin } from "@/lib/access";
import PageHeader from "@/components/layout/PageHeader";
import EmptyState from "@/components/ui/EmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import AssignedSubmissions from "@/components/avaliador/AssignedSubmissions";

export default function PainelAvaliador() {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const qc = useQueryClient();

  const membershipsQuery = useQuery({
    queryKey: ["my-memberships", user?.id],
    queryFn: () => getMyMemberships(user?.id),
    enabled: !!user?.id,
  });

  const isReviewer = admin || hasRole(membershipsQuery.data, "reviewer");

  const assignmentsQuery = useQuery({
    queryKey: ["my-assignments", user?.id],
    queryFn: async () => {
      const res = await base44.functions.invoke("manageAward", { action: "listMyAssignments" });
      return res.data ?? res;
    },
    enabled: !!user?.id && isReviewer,
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
        <EmptyState icon={Trophy} title="Você não faz parte de nenhuma comissão" description="Quando um gestor te designar como avaliador de uma premiação, seus cases aparecerão aqui." />
      </div>
    );
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ["my-assignments", user?.id] });

  return (
    <div className="space-y-6">
      <PageHeader icon={Award} title="Painel do Avaliador" subtitle="Comitê de premiação" tone="success" />
      {assignmentsQuery.isLoading ? (
        <ListSkeleton count={3} />
      ) : (
        <AssignedSubmissions assignments={assignmentsQuery.data} onEvaluated={invalidate} />
      )}
    </div>
  );
}
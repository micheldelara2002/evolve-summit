import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Award } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import PageHeader from "@/components/layout/PageHeader";
import EmptyState from "@/components/ui/EmptyState";
import ListSkeleton from "@/components/ui/ListSkeleton";
import AssignedSubmissions from "@/components/avaliador/AssignedSubmissions";

export default function PainelAvaliador() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const assignmentsQuery = useQuery({
    queryKey: ["my-assignments", user?.id],
    queryFn: async () => {
      const res = await base44.functions.invoke("manageAward", { action: "listMyAssignments" });
      return res.data ?? res;
    },
    enabled: !!user?.id,
  });

  const hasAssignments = (assignmentsQuery.data?.submissions || []).length > 0;

  return (
    <div className="space-y-6">
      <PageHeader icon={Award} title="Painel do Avaliador" subtitle="Comitê de premiação" tone="success" />
      {assignmentsQuery.isLoading ? (
        <ListSkeleton count={3} />
      ) : !hasAssignments ? (
        <EmptyState icon={Award} title="Nenhum case designado" description="Quando um gestor te incluir na banca de uma premiação, os cases aparecerão aqui." />
      ) : (
        <AssignedSubmissions
          assignments={assignmentsQuery.data}
          onEvaluated={() => qc.invalidateQueries({ queryKey: ["my-assignments", user?.id] })}
        />
      )}
    </div>
  );
}
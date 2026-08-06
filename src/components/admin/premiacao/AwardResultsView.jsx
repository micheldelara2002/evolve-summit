import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import EmptyState from "@/components/ui/EmptyState";
import { Medal } from "lucide-react";

export default function AwardResultsView({ eventId }) {
  const [categoryFilter, setCategoryFilter] = useState("all");
  const { data: categories = [] } = useQuery({ queryKey: ["award-categories", eventId], queryFn: () => base44.entities.AwardCategory.filter({ event_id: eventId, is_deleted: false }) });

  const { data, isLoading } = useQuery({
    queryKey: ["award-results", eventId, categoryFilter],
    queryFn: async () => {
      const res = await base44.functions.invoke("manageAward", { action: "listResults", event_id: eventId, category_id: categoryFilter === "all" ? undefined : categoryFilter });
      return res.data;
    },
    enabled: !!eventId,
  });

  const results = data?.results || [];
  const catName = (id) => categories.find((c) => c.id === id)?.name;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-56"><SelectValue placeholder="Filtrar categoria" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as categorias</SelectItem>
            {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando resultados...</p>
      ) : results.length === 0 ? (
        <EmptyState icon={Medal} title="Sem avaliações ainda" description="Quando os avaliadores enviarem notas, o ranking aparecerá aqui." />
      ) : (
        <div className="space-y-2">
          {results.map((r, idx) => (
            <div key={r.nomination.id} className="rounded-xl border border-border bg-card p-3 flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold shrink-0">{idx + 1}</div>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{r.nomination.nominee_name}</p>
                <p className="text-xs text-muted-foreground truncate">{r.nomination.nominee_subtitle || catName(r.nomination.category_id)}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="font-display font-bold text-lg">{r.avg_score.toFixed(2)}</p>
                <p className="text-xs text-muted-foreground">{r.reviewers_count} aval.</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
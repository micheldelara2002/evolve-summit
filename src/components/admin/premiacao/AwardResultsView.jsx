import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import EmptyState from "@/components/ui/EmptyState";
import { Medal } from "lucide-react";

export default function AwardResultsView({ eventId }) {
  const [awardFilter, setAwardFilter] = useState("all");
  const { data: configs = [] } = useQuery({
    queryKey: ["award-configs", eventId],
    queryFn: async () => {
      const response = await base44.functions.invoke("manageEventConfig", { action: "list", entityName: "AwardConfig", eventId });
      return response.data?.records || response.records || [];
    },
  });

  const { data, isLoading } = useQuery({
    queryKey: ["award-results", eventId, awardFilter],
    queryFn: async () => {
      const res = await base44.functions.invoke("manageAward", { action: "listResults", event_id: eventId, award_id: awardFilter === "all" ? undefined : awardFilter });
      return res.data ?? res;
    },
    enabled: !!eventId,
  });

  const results = data?.results || [];
  const configName = (id) => configs.find((c) => c.id === id)?.title;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Select value={awardFilter} onValueChange={setAwardFilter}>
          <SelectTrigger className="w-56"><SelectValue placeholder="Filtrar premiação" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas as premiações</SelectItem>
            {configs.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando resultados...</p>
      ) : results.length === 0 ? (
        <EmptyState icon={Medal} title="Sem avaliações ainda" description="Quando o comitê enviar notas, o ranking aparecerá aqui." />
      ) : (
        <div className="space-y-2">
          {results.map((r, idx) => (
            <div key={r.submission.id} className="rounded-xl border border-border bg-card p-3 flex items-center gap-3">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0 ${idx === 0 ? "bg-warning/15 text-warning" : "bg-primary/10 text-primary"}`}>{idx + 1}</div>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{r.submission.title}</p>
                <p className="text-xs text-muted-foreground truncate">por {r.submission.submitter_name} · {configName(r.submission.award_id)}</p>
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
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClipboardCheck, CheckCircle2 } from "lucide-react";
import EvaluationForm from "./EvaluationForm";

export default function NominationList({ categories, nominations, myEvaluations, onEvaluated }) {
  const [evaluating, setEvaluating] = useState(null);

  const evalByNom = {};
  for (const e of myEvaluations) evalByNom[e.nomination_id] = e;

  const grouped = categories
    .filter((c) => c.is_active)
    .map((cat) => ({
      category: cat,
      noms: nominations.filter((n) => n.category_id === cat.id && n.status !== "rejected"),
    }))
    .filter((g) => g.noms.length > 0);

  if (grouped.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">Nenhuma indicação disponível para avaliação.</p>;
  }

  return (
    <div className="space-y-5">
      {grouped.map(({ category, noms }) => (
        <div key={category.id} className="space-y-2">
          <h3 className="font-display font-semibold">{category.name}</h3>
          {category.description && <p className="text-xs text-muted-foreground -mt-1">{category.description}</p>}
          <div className="space-y-2">
            {noms.map((n) => {
              const ev = evalByNom[n.id];
              return (
                <div key={n.id} className="rounded-xl border border-border bg-card p-3 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{n.nominee_name}</p>
                    {n.nominee_subtitle && <p className="text-xs text-muted-foreground truncate">{n.nominee_subtitle}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {ev ? (
                      <Badge variant="secondary" className="bg-success/15 text-success flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Avaliado</Badge>
                    ) : (
                      <Badge variant="outline">Pendente</Badge>
                    )}
                    <Button size="sm" variant={ev ? "outline" : "default"} onClick={() => setEvaluating({ nomination: n, category, existing: ev })}>
                      <ClipboardCheck className="w-4 h-4" /> {ev ? "Reavaliar" : "Avaliar"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {evaluating && (
        <EvaluationForm
          open
          onClose={() => setEvaluating(null)}
          onSaved={() => { onEvaluated?.(); setEvaluating(null); }}
          nomination={evaluating.nomination}
          category={evaluating.category}
          existing={evaluating.existing}
        />
      )}
    </div>
  );
}
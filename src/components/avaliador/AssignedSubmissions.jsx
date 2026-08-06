import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClipboardCheck, CheckCircle2 } from "lucide-react";
import EvaluationForm from "./EvaluationForm";

export default function AssignedSubmissions({ assignments, onEvaluated }) {
  const [evaluating, setEvaluating] = useState(null);
  const { submissions = [], configs = {}, evaluations = {} } = assignments || {};

  if (submissions.length === 0) {
    return <p className="text-sm text-muted-foreground py-6 text-center">Nenhum case designado para você ainda.</p>;
  }

  // Agrupar por award_id
  const groups = {};
  for (const s of submissions) {
    (groups[s.award_id] = groups[s.award_id] || []).push(s);
  }

  return (
    <div className="space-y-5">
      {Object.entries(groups).map(([awardId, subs]) => {
        const cfg = configs[awardId];
        return (
          <div key={awardId} className="space-y-2">
            <h3 className="font-display font-semibold">{cfg?.title || "Premiação"}</h3>
            {cfg?.description && <p className="text-xs text-muted-foreground -mt-1">{cfg.description}</p>}
            <div className="space-y-2">
              {subs.map((s) => {
                const ev = evaluations[s.id];
                return (
                  <div key={s.id} className="rounded-xl border border-border bg-card p-3 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{s.title}</p>
                      <p className="text-xs text-muted-foreground truncate">por {s.submitter_name}</p>
                      {ev && <p className="text-xs text-success mt-0.5">Nota: {ev.total_score}</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {ev ? (
                        <Badge variant="secondary" className="bg-success/15 text-success flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Avaliado</Badge>
                      ) : (
                        <Badge variant="outline">Pendente</Badge>
                      )}
                      <Button size="sm" variant={ev ? "outline" : "default"} onClick={() => setEvaluating({ submission: s, config: cfg, existing: ev })}>
                        <ClipboardCheck className="w-4 h-4" /> {ev ? "Reavaliar" : "Avaliar"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {evaluating && (
        <EvaluationForm
          open
          onClose={() => setEvaluating(null)}
          onSaved={() => { onEvaluated?.(); setEvaluating(null); }}
          submission={evaluating.submission}
          config={evaluating.config}
        />
      )}
    </div>
  );
}
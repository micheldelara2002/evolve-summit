/**
 * Lista todas as chamadas de palestras abertas (em todos os eventos).
 * Ponto de entrada para "potenciais palestrantes" submeterem propostas.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Link } from "react-router-dom";
import { Megaphone, Calendar, ArrowRight } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";

function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

export default function CallForPapersList() {
  const { data: openCfps = [], isLoading } = useQuery({
    queryKey: ["cfps-open"],
    queryFn: async () => {
      const all = await base44.entities.CallForPapers.filter({ is_active: true, is_deleted: false });
      const now = new Date();
      return all
        .filter((c) => c.start_date && new Date(c.start_date) <= now && (!c.end_date || new Date(c.end_date) > now))
        .sort((a, b) => new Date(a.end_date || 0) - new Date(b.end_date || 0));
    },
  });

  const eventIds = [...new Set(openCfps.map((c) => c.event_id))];
  const { data: events = [] } = useQuery({
    queryKey: ["cfp-list-events", eventIds.join(",")],
    queryFn: () => eventIds.length ? base44.entities.Event.filter({ id: { $in: eventIds }, is_deleted: false }) : [],
    enabled: eventIds.length > 0,
  });
  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]));

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <PageHeader icon={Megaphone} title="Call for Papers" subtitle="Submeta sua palestra para eventos abertos" tone="secondary" />

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : openCfps.length === 0 ? (
        <div className="text-center py-16">
          <Megaphone className="w-10 h-10 mx-auto text-muted-foreground/40" />
          <p className="mt-3 text-sm text-muted-foreground">Nenhuma chamada de palestras aberta no momento.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {openCfps.map((cfp) => {
            const ev = eventMap[cfp.event_id];
            return (
              <Link
                key={cfp.id}
                to={`/cfp/${cfp.id}/submit`}
                className="block rounded-2xl border border-border bg-card p-4 hover:border-primary/40 hover:shadow-md transition-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-display font-semibold">{cfp.title}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">{ev?.name || "Evento"}</p>
                    {cfp.description && <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{cfp.description}</p>}
                  </div>
                  <ArrowRight className="w-5 h-5 text-primary shrink-0" />
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground mt-3">
                  <Calendar className="w-3.5 h-3.5" />
                  Fecha em {fmtDate(cfp.end_date)}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
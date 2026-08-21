/**
 * Lista premiações abertas (em todos os eventos) + "Minhas inscrições".
 * Ponto de entrada para candidatos (entrants) submeterem cases.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Link } from "react-router-dom";
import { Medal, Calendar, ArrowRight, Trophy } from "lucide-react";
import PageHeader from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";

function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

const STATUS_LABEL = {
  pending: "Pendente", in_review: "Em avaliação", finalist: "Finalista", winner: "Vencedor", rejected: "Rejeitado",
};
const STATUS_STYLE = {
  pending: "bg-warning/10 text-warning", in_review: "bg-primary/10 text-primary", finalist: "bg-secondary/15 text-secondary",
  winner: "bg-success/10 text-success", rejected: "bg-destructive/10 text-destructive",
};

export default function AwardsList() {
  const { data: openAwards = [], isLoading } = useQuery({
    queryKey: ["awards-open"],
    queryFn: async () => {
      const response = await base44.functions.invoke("manageEventConfig", { action: "list", entityName: "AwardConfig" });
      const all = response.data?.records || response.records || [];
      const now = new Date();
      return all
        .filter((a) => a.start_date && new Date(a.start_date) <= now && (!a.end_date || new Date(a.end_date) > now))
        .sort((a, b) => new Date(a.end_date || 0) - new Date(b.end_date || 0));
    },
  });

  const eventIds = [...new Set(openAwards.map((a) => a.event_id))];
  const { data: events = [] } = useQuery({
    queryKey: ["awards-events", eventIds.join(",")],
    queryFn: () => eventIds.length ? base44.entities.Event.filter({ id: { $in: eventIds }, is_deleted: false }) : [],
    enabled: eventIds.length > 0,
  });
  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]));

  const { data: mySubmissions = [] } = useQuery({
    queryKey: ["my-award-submissions"],
    queryFn: () => base44.entities.AwardSubmission.list("-created_date", 50),
  });

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader icon={Medal} title="Premiações" subtitle="Inscreva seu case para prêmios abertos" tone="success" />

      {mySubmissions.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Minhas inscrições</h2>
          {mySubmissions.map((s) => (
            <div key={s.id} className="rounded-xl border border-border bg-card p-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium truncate">{s.title}</p>
                <p className="text-xs text-muted-foreground truncate">{eventMap[openAwards.find((a) => a.id === s.award_id)?.event_id]?.name || "Evento"}</p>
              </div>
              <Badge className={`shrink-0 ${STATUS_STYLE[s.status] || ""}`}>{STATUS_LABEL[s.status] || s.status}</Badge>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Premiações abertas</h2>
        {isLoading ? (
          <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
        ) : openAwards.length === 0 ? (
          <div className="text-center py-16">
            <Trophy className="w-10 h-10 mx-auto text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">Nenhuma premiação aberta no momento.</p>
          </div>
        ) : (
          openAwards.map((a) => {
            const ev = eventMap[a.event_id];
            return (
              <Link key={a.id} to={`/awards/${a.id}/submit`} className="block rounded-2xl border border-border bg-card p-4 hover:border-primary/40 hover:shadow-md transition-all">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-display font-semibold">{a.title}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">{ev?.name || "Evento"}</p>
                    {a.description && <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{a.description}</p>}
                  </div>
                  <ArrowRight className="w-5 h-5 text-primary shrink-0" />
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground mt-3">
                  <Calendar className="w-3.5 h-3.5" /> Fecha em {fmtDate(a.end_date)}
                </div>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
/**
 * Lista histórico de sorteios de um evento.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Trophy, CheckCircle2, Clock } from "lucide-react";

function formatDt(dt) {
  if (!dt) return "—";
  return new Date(dt).toLocaleString("pt-BR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const CONTEXT_LABELS = { organizer: "Organizador", speaker: "Palestrante", partner: "Parceiro" };
const STATUS_CONFIG = {
  saved: { label: "Finalizado", color: "text-emerald-600 bg-emerald-50 border-emerald-200" },
  running: { label: "Em andamento", color: "text-amber-600 bg-amber-50 border-amber-200" },
  draft: { label: "Rascunho", color: "text-muted-foreground bg-muted border-border" },
};

export default function RaffleHistory({ eventId }) {
  const { data: raffles = [], isLoading } = useQuery({
    queryKey: ["raffles", eventId],
    queryFn: async () => {
      const res = await base44.functions.invoke('getEventRaffles', { eventId });
      return res.data?.raffles || [];
    },
    enabled: !!eventId,
  });

  const sorted = [...raffles].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!sorted.length) {
    return (
      <div className="text-center py-10 text-muted-foreground text-sm space-y-2">
        <Trophy className="w-8 h-8 mx-auto opacity-30" />
        <p>Nenhum sorteio realizado neste evento.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sorted.map((raffle) => {
        const winners = (() => { try { return JSON.parse(raffle.winners || "[]"); } catch { return []; } })();
        const confirmed = winners.filter((w) => w.confirmed).length;
        const statusCfg = STATUS_CONFIG[raffle.status] || STATUS_CONFIG.draft;

        return (
          <div key={raffle.id} className="rounded-2xl border border-border bg-card p-4 space-y-3">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Trophy className="w-4 h-4 text-amber-500 shrink-0" />
                  <p className="font-display font-semibold truncate">{raffle.title}</p>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0 ${statusCfg.color}`}>
                    {statusCfg.label}
                  </span>
                </div>
                {raffle.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{raffle.description}</p>
                )}
              </div>
            </div>

            {/* Meta */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>Por: <strong className="text-foreground">{raffle.drawn_by_label || CONTEXT_LABELS[raffle.context] || raffle.context}</strong></span>
              <span>Vencedores: <strong className="text-foreground">{winners.length}/{raffle.winner_count}</strong></span>
              <span>Confirmados (joinha): <strong className="text-emerald-600">{confirmed}</strong></span>
              <span>Elegíveis: <strong className="text-foreground">{raffle.eligible_total ?? "—"}</strong></span>
              {raffle.saved_at && <span>Salvo em: <strong className="text-foreground">{formatDt(raffle.saved_at)}</strong></span>}
            </div>

            {/* Winners list */}
            {winners.length > 0 && (
              <div className="space-y-1.5">
                {winners.map((w, i) => (
                  <div key={w.id || i} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${w.confirmed ? "bg-emerald-50 border border-emerald-200" : "bg-muted/30 border border-border"}`}>
                    <div className="w-6 h-6 rounded-full bg-primary/10 text-primary font-bold text-xs flex items-center justify-center shrink-0">
                      {w.full_name?.[0]?.toUpperCase() ?? "?"}
                    </div>
                    <span className="flex-1 truncate">{w.full_name}</span>
                    {w.confirmed ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    ) : (
                      <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
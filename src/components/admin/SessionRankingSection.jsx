/**
 * Ranking de Sessões para o Gerente do Evento — indicadores por sessão
 * com score ponderado (média * taxa). Somente leitura.
 * Mínimo 5 avaliações para ranking principal; abaixo = "Em observação".
 */
import { useQuery, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { Trophy, Eye, Medal } from "lucide-react";
import { buildSessionMetrics } from "@/lib/rankingUtils";

const MEDAL = ["#FFD700", "#C0C0C0", "#CD7F32"];

export default function SessionRankingSection({ eventId, sessions = [] }) {
  const { data: reviews = [], isLoading } = useQuery({
    queryKey: ["session-ranking-reviews", eventId],
    queryFn: async () => {
      if (!eventId) return [];
      const all = await base44.entities.SessionReview.filter({ event_id: eventId });
      return all;
    },
    enabled: !!eventId,
  });

  const { data: attendances = [] } = useQuery({
    queryKey: ["session-ranking-attendances", eventId],
    queryFn: async () => {
      if (!eventId) return [];
      const all = await base44.entities.SessionAttendance.filter({ event_id: eventId });
      return all;
    },
    enabled: !!eventId,
  });

  const metrics = useMemo(
    () => buildSessionMetrics(sessions, reviews, attendances),
    [sessions, reviews, attendances]
  );

  const sorted = [...metrics].sort((a, b) => b.weightedScore - a.weightedScore);
  const mainRanking = sorted.filter((m) => !m.isObservable);
  const observacao = sorted.filter((m) => m.isObservable);
  const top3 = mainRanking.slice(0, 3);
  const restMain = mainRanking.slice(3);
  const podiumOrder = [1, 0, 2];

  if (isLoading) {
    return <div className="flex justify-center py-6"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (metrics.length === 0 || metrics.every((m) => m.reviewCount === 0 && m.presenceCount === 0)) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center">
        <Trophy className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p className="text-sm text-muted-foreground">Sem dados de avaliação ou presença para este evento ainda.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-base font-display font-semibold flex items-center gap-2">
        <Trophy className="w-4 h-4 text-primary" /> Ranking de Palestras
      </h3>

      {/* Pódio Top 3 */}
      {top3.length > 0 && (
        <div className="flex items-end justify-center gap-2 py-2">
          {podiumOrder.map((idx) => {
            if (!top3[idx]) return null;
            const m = top3[idx];
            const isFirst = idx === 0;
            return (
              <div key={m.session.id} className="flex flex-col items-center gap-1">
                <div className={`rounded-full flex items-center justify-center text-white font-bold ${isFirst ? "w-10 h-10 text-base" : "w-8 h-8 text-sm"}`} style={{ backgroundColor: MEDAL[idx] }}>
                  {idx + 1}
                </div>
                <p className="text-xs font-medium text-center max-w-[100px] truncate">{m.session.title}</p>
                <p className="text-[10px] text-muted-foreground truncate max-w-[100px]">{m.session.speaker_name || "—"}</p>
                <p className="text-sm font-bold text-primary">{m.weightedScore.toFixed(2)}</p>
                <div className={`rounded-t-lg flex items-center justify-center ${isFirst ? "w-16 h-14" : "w-14 h-10"}`} style={{ backgroundColor: MEDAL[idx] + "22" }}>
                  <Medal className={isFirst ? "w-6 h-6" : "w-5 h-5"} style={{ color: MEDAL[idx] }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Tabela ranking principal */}
      {restMain.length > 0 && (
        <div className="rounded-xl border border-border overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/40 text-xs text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">#</th>
                <th className="px-3 py-2 text-left font-medium">Sessão</th>
                <th className="px-3 py-2 text-left font-medium">Palestrante</th>
                <th className="px-3 py-2 text-right font-medium">Média</th>
                <th className="px-3 py-2 text-right font-medium">Taxa</th>
                <th className="px-3 py-2 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {restMain.map((m, i) => (
                <tr key={m.session.id}>
                  <td className="px-3 py-2.5 text-muted-foreground font-medium">{i + 4}</td>
                  <td className="px-3 py-2.5 font-medium truncate max-w-[160px]">{m.session.title}</td>
                  <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[120px]">{m.session.speaker_name || "—"}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-amber-600">{m.avgRating.toFixed(1)}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-emerald-600">{Math.round(m.evaluationRate * 100)}%</td>
                  <td className="px-3 py-2.5 text-right font-bold text-primary">{m.weightedScore.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Em observação */}
      {observacao.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 overflow-hidden overflow-x-auto">
          <div className="px-4 py-2 text-xs font-semibold text-amber-700 flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5" /> Em observação (menos de 5 avaliações)
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Sessão</th>
                <th className="px-3 py-2 text-left font-medium">Palestrante</th>
                <th className="px-3 py-2 text-right font-medium">Média</th>
                <th className="px-3 py-2 text-right font-medium">Aval.</th>
                <th className="px-3 py-2 text-right font-medium">Pres.</th>
                <th className="px-3 py-2 text-right font-medium">Taxa</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-amber-100">
              {observacao.map((m) => (
                <tr key={m.session.id}>
                  <td className="px-3 py-2.5 font-medium truncate max-w-[160px]">{m.session.title}</td>
                  <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[120px]">{m.session.speaker_name || "—"}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-amber-600">{m.avgRating.toFixed(1)}</td>
                  <td className="px-3 py-2.5 text-right">{m.reviewCount}</td>
                  <td className="px-3 py-2.5 text-right">{m.presenceCount}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-emerald-600">{Math.round(m.evaluationRate * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
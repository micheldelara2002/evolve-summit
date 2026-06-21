/**
 * Aba Feedbacks na gestão do evento (admin/gerente — somente leitura).
 * Lista todos os feedbacks e exibe consolidado % positivo / % negativo.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { ThumbsUp, ThumbsDown, MessageSquare } from "lucide-react";

export default function FeedbacksTab({ eventId }) {
  const { data: feedbacks = [], isLoading } = useQuery({
    queryKey: ["feedbacks", eventId],
    queryFn: () => base44.entities.Feedback.filter({ event_id: eventId, is_deleted: false }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const total = feedbacks.length;
  const positivos = feedbacks.filter((f) => f.tipo === "positivo").length;
  const negativos = feedbacks.filter((f) => f.tipo === "negativo").length;
  const pctPos = total > 0 ? Math.round((positivos / total) * 100) : 0;
  const pctNeg = total > 0 ? Math.round((negativos / total) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* Consolidado */}
      {total > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-2xl border border-border bg-card p-4 text-center">
            <p className="text-2xl font-display font-bold">{total}</p>
            <p className="text-xs text-muted-foreground mt-1">Total</p>
          </div>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center">
            <div className="flex items-center justify-center gap-1.5 mb-0.5">
              <ThumbsUp className="w-4 h-4 text-emerald-600" />
              <p className="text-2xl font-display font-bold text-emerald-700">{pctPos}%</p>
            </div>
            <p className="text-xs text-emerald-600">{positivos} positivos</p>
          </div>
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-center">
            <div className="flex items-center justify-center gap-1.5 mb-0.5">
              <ThumbsDown className="w-4 h-4 text-rose-600" />
              <p className="text-2xl font-display font-bold text-rose-700">{pctNeg}%</p>
            </div>
            <p className="text-xs text-rose-600">{negativos} negativos</p>
          </div>
        </div>
      )}

      {/* Barra visual */}
      {total > 0 && (
        <div className="h-3 rounded-full overflow-hidden bg-rose-200 flex">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${pctPos}%` }}
          />
        </div>
      )}

      {/* Lista */}
      {total === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>Nenhum feedback recebido ainda.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {feedbacks
            .slice()
            .sort((a, b) => new Date(b.created_date) - new Date(a.created_date))
            .map((fb) => (
              <div
                key={fb.id}
                className={`rounded-xl border p-4 flex gap-3 ${
                  fb.tipo === "positivo"
                    ? "border-emerald-200 bg-emerald-50/40"
                    : "border-rose-200 bg-rose-50/40"
                }`}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                  fb.tipo === "positivo" ? "bg-emerald-100 text-emerald-600" : "bg-rose-100 text-rose-600"
                }`}>
                  {fb.tipo === "positivo" ? <ThumbsUp className="w-4 h-4" /> : <ThumbsDown className="w-4 h-4" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{fb.mensagem}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {fb.created_date ? new Date(fb.created_date).toLocaleString("pt-BR") : ""}
                  </p>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
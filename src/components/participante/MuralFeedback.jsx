/**
 * Mural de Feedback — componente do participante.
 * Envio: máx 500 chars, classificação positivo/negativo.
 * Evento finished: somente leitura.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { ThumbsUp, ThumbsDown, Send, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { sanitizeText } from "@/utils/sanitize";

const MAX_CHARS = 500;

export default function MuralFeedback({ eventId, participantId, personId, userId, isReadOnly }) {
  const queryClient = useQueryClient();
  const [mensagem, setMensagem] = useState("");
  const [tipo, setTipo] = useState(null); // "positivo" | "negativo"

  const { data: feedbacks = [], isLoading } = useQuery({
    queryKey: ["feedbacks", eventId],
    queryFn: () => base44.entities.Feedback.filter({ event_id: eventId, is_deleted: false }),
  });

  const sendMut = useMutation({
    mutationFn: () =>
      base44.entities.Feedback.create({
        event_id: eventId,
        participant_id: participantId || undefined,
        person_id: personId || undefined,
        user_id: userId || undefined,
        tipo,
        mensagem: sanitizeText(mensagem.trim()),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feedbacks", eventId] });
      setMensagem("");
      setTipo(null);
      toast.success("Feedback enviado!");
    },
  });

  const canSubmit = !isReadOnly && tipo && mensagem.trim().length > 0 && mensagem.trim().length <= MAX_CHARS;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-display font-semibold">Mural de Feedback</h2>
        {isReadOnly && (
          <span className="text-xs text-muted-foreground bg-muted rounded-full px-3 py-1">Modo consulta</span>
        )}
      </div>

      {/* Form */}
      {!isReadOnly && (
        <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
          {/* Classificação */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Como foi sua experiência? *</p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setTipo("positivo")}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 text-sm font-medium transition-all
                  ${tipo === "positivo"
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                    : "border-border bg-background text-muted-foreground hover:border-emerald-300"
                  }`}
              >
                <ThumbsUp className="w-4 h-4" /> Positivo
              </button>
              <button
                type="button"
                onClick={() => setTipo("negativo")}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 text-sm font-medium transition-all
                  ${tipo === "negativo"
                    ? "border-rose-500 bg-rose-50 text-rose-700"
                    : "border-border bg-background text-muted-foreground hover:border-rose-300"
                  }`}
              >
                <ThumbsDown className="w-4 h-4" /> Negativo
              </button>
            </div>
          </div>

          {/* Mensagem */}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Sua mensagem *</p>
            <textarea
              className="w-full rounded-xl border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
              rows={4}
              maxLength={MAX_CHARS}
              placeholder="Escreva seu feedback aqui..."
              value={mensagem}
              onChange={(e) => setMensagem(e.target.value)}
            />
            <p className={`text-xs text-right ${mensagem.length >= MAX_CHARS ? "text-destructive" : "text-muted-foreground"}`}>
              {mensagem.length}/{MAX_CHARS}
            </p>
          </div>

          <Button
            className="w-full gap-2"
            disabled={!canSubmit || sendMut.isPending}
            onClick={() => sendMut.mutate()}
          >
            <Send className="w-4 h-4" />
            {sendMut.isPending ? "Enviando..." : "Enviar Feedback"}
          </Button>
        </div>
      )}

      {/* Feed */}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : feedbacks.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>Nenhum feedback enviado ainda.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{feedbacks.length} feedback(s) recebido(s)</p>
          {feedbacks
            .slice()
            .sort((a, b) => new Date(b.created_date) - new Date(a.created_date))
            .map((fb) => (
              <div
                key={fb.id}
                className={`rounded-xl border p-4 flex gap-3 ${
                  fb.tipo === "positivo"
                    ? "border-emerald-200 bg-emerald-50/50"
                    : "border-rose-200 bg-rose-50/50"
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
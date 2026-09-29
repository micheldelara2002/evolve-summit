/**
 * Seção de perguntas e respostas da sessão: envio (pública/particular),
 * marcação de respondida e respostas do palestrante. Perguntas com ≥25
 * caracteres pontuam via motor de pontuação.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { processAction } from "@/lib/scoringEngine";
import { sanitizeText } from "@/utils/sanitize";
import { Button } from "@/components/ui/button";
import { Send, ThumbsUp } from "lucide-react";
import { toast } from "sonner";

export default function QASection({ session, participant, myParticipantId, isReadOnly }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState("publica");
  const [replyTexts, setReplyTexts] = useState({});

  const isSpeaker = participant?.role_in_event === "speaker";

  const { data: questions = [] } = useQuery({
    queryKey: ["session-questions", session.id],
    queryFn: async () => {
      const res = await base44.functions.invoke('getSessionQuestions', { sessionId: session.id });
      return res.data?.questions || [];
    },
  });

  const sendMut = useMutation({
    mutationFn: () => base44.functions.invoke('manageSessionQuestion', {
      operation: 'create',
      sessionId: session.id,
      data: { question: sanitizeText(text.trim()), visibility },
    }),
    onSuccess: async () => {
      const questionText = text.trim();
      queryClient.invalidateQueries({ queryKey: ["session-questions", session.id] });
      setText("");
      toast.success("Pergunta enviada!");
      if (participant?.id && questionText.length >= 25) {
        await processAction({
          eventId: session.event_id,
          participantId: participant.id,
          personId: participant.person_id,
          acao: "pergunta_valida",
          refId: session.id,
        });
        queryClient.invalidateQueries({ queryKey: ["my_participant_points"] });
      }
    },
  });

  const markMut = useMutation({
    mutationFn: (q) => base44.functions.invoke('manageSessionQuestion', {
      operation: 'markAnswered',
      questionId: q.id,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-questions", session.id] }),
  });

  const replyMut = useMutation({
    mutationFn: ({ question, replyText }) => base44.functions.invoke('manageSessionAnswer', {
      operation: 'save',
      questionId: question.id,
      answerText: sanitizeText(replyText),
    }),
    onSuccess: (_, { question }) => {
      queryClient.invalidateQueries({ queryKey: ["session-questions", session.id] });
      setReplyTexts((prev) => ({ ...prev, [question.id]: "" }));
      toast.success("Resposta enviada!");
    },
  });

  return (
    <div className="space-y-3">
      {!isReadOnly && (
        <div className="space-y-2">
          <textarea
            className="w-full rounded-xl border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
            rows={3}
            placeholder="Digite sua pergunta..."
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex gap-2">
              {[{ v: "publica", label: "🌐 Pública" }, { v: "particular", label: "🔒 Particular" }].map(({ v, label }) => (
                <button
                  key={v}
                  onClick={() => setVisibility(v)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    visibility === v ? "border-primary bg-primary/10 text-primary font-medium" : "border-border text-muted-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <Button size="sm" className="gap-1.5" disabled={!text.trim() || sendMut.isPending} onClick={() => sendMut.mutate()}>
              <Send className="w-3.5 h-3.5" /> Enviar
            </Button>
          </div>
          {text.trim().length > 0 && text.trim().length < 25 && (
            <p className="text-xs text-muted-foreground">Mínimo de 25 caracteres para pontuar.</p>
          )}
        </div>
      )}

      <div className="space-y-2">
        {questions.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-3">Nenhuma pergunta ainda.</p>
        )}
        {questions.map((q) => {
          const answer = q.answer;
          const replyText = replyTexts[q.id] || "";
          return (
            <div key={q.id} className={`rounded-xl p-3 border text-sm space-y-2 ${q.is_answered ? "border-emerald-200 bg-emerald-50/50" : "border-border"}`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p>{q.question}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${q.visibility === "particular" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"}`}>
                      {q.visibility === "particular" ? "🔒 Particular" : "🌐 Pública"}
                    </span>
                    {q.is_answered && <span className="text-[10px] text-emerald-600 font-medium">✓ Respondida</span>}
                  </div>
                </div>
                {isSpeaker && (
                  <button
                    onClick={() => markMut.mutate(q)}
                    className={`shrink-0 p-1.5 rounded-lg transition-colors ${q.is_answered ? "text-emerald-600 bg-emerald-100" : "text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50"}`}
                    title="Marcar respondida"
                  >
                    <ThumbsUp className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Resposta do palestrante */}
              {answer && (
                <div className="ml-2 pl-3 border-l-2 border-primary/30 text-xs text-muted-foreground">
                  <span className="font-medium text-primary block mb-0.5">Palestrante respondeu:</span>
                  {answer.answer_text}
                </div>
              )}

              {/* Campo de resposta (apenas para palestrante) */}
              {isSpeaker && !isReadOnly && (
                <div className="flex gap-2 mt-1">
                  <textarea
                    className="flex-1 rounded-lg border border-input bg-transparent px-2 py-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                    rows={2}
                    placeholder={answer ? "Editar resposta..." : "Responder..."}
                    value={replyText}
                    onChange={(e) => setReplyTexts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!replyText.trim() || replyMut.isPending}
                    onClick={() => replyMut.mutate({ question: q, replyText: replyText.trim() })}
                    className="self-end"
                  >
                    <Send className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
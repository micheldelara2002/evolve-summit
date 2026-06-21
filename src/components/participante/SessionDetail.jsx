/**
 * Detalhe de uma sessão para o participante.
 * - Toggle de presença (controla acesso aos recursos)
 * - Perguntas públicas/particulares
 * - Avaliação (0-10 + comentário)
 * - Solicitar mentoria
 * - Baixar material
 * Motor de pontuação integrado.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { processAction } from "@/lib/scoringEngine";
import { Button } from "@/components/ui/button";
import {
  X, MessageCircleQuestion, Star, BookUser,
  Download, ThumbsUp, Lock, CheckCircle2, Clock, MapPin, Mic, Send, UserCheck, BookOpen,
} from "lucide-react";
import { toast } from "sonner";

function formatTime(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

const SESSION_TYPE_LABELS = {
  aula: "Aula", debate: "Debate", demonstracao: "Demonstração",
  keynote: "Keynote", mesa_redonda: "Mesa redonda", palestra: "Palestra",
  painel: "Painel", simulacao: "Simulação", workshop: "Workshop",
};

// ── Section wrapper ───────────────────────────────────────────────────────────
function Section({ title, icon: Icon, children, locked }) {
  return (
    <div className={`rounded-2xl border p-4 space-y-3 ${locked ? "border-border bg-muted/20 opacity-60 pointer-events-none" : "border-border bg-card"}`}>
      <div className="flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        <h3 className="font-semibold text-sm">{title}</h3>
        {locked && <Lock className="w-3.5 h-3.5 text-muted-foreground ml-auto" />}
      </div>
      {locked ? (
        <p className="text-xs text-muted-foreground">Registre presença para acessar.</p>
      ) : children}
    </div>
  );
}

// ── Q&A ───────────────────────────────────────────────────────────────────────
function QASection({ session, participant, myParticipantId, isReadOnly }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState("publica");

  const isSpeaker = participant?.role_in_event === "speaker";

  const { data: questions = [] } = useQuery({
    queryKey: ["session-questions", session.id],
    queryFn: () => base44.entities.SessionQuestion.filter({ session_id: session.id, is_deleted: false }),
  });

  const visibleQuestions = questions.filter((q) => {
    if (q.visibility === "particular") return isSpeaker || q.participant_id === myParticipantId;
    return true;
  });

  const sendMut = useMutation({
    mutationFn: () => base44.entities.SessionQuestion.create({
      event_id: session.event_id,
      session_id: session.id,
      participant_id: participant?.id,
      person_id: participant?.person_id,
      question: text.trim(),
      visibility,
    }),
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["session-questions", session.id] });
      setText("");
      toast.success("Pergunta enviada!");
      if (participant?.id) {
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

  const answerMut = useMutation({
    mutationFn: (q) => base44.entities.SessionQuestion.update(q.id, { is_answered: !q.is_answered }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-questions", session.id] }),
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
        </div>
      )}

      <div className="space-y-2">
        {visibleQuestions.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-3">Nenhuma pergunta ainda.</p>
        )}
        {visibleQuestions.map((q) => (
          <div key={q.id} className={`rounded-xl p-3 border text-sm flex items-start gap-2 ${q.is_answered ? "border-emerald-200 bg-emerald-50/50" : "border-border"}`}>
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
                onClick={() => answerMut.mutate(q)}
                className={`shrink-0 p-1.5 rounded-lg transition-colors ${q.is_answered ? "text-emerald-600 bg-emerald-100" : "text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50"}`}
                title="Marcar respondida"
              >
                <ThumbsUp className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Rating ────────────────────────────────────────────────────────────────────
function RatingSection({ session, participant, isReadOnly }) {
  const queryClient = useQueryClient();
  const [rating, setRating] = useState(null);
  const [comment, setComment] = useState("");

  const { data: existingReviews = [] } = useQuery({
    queryKey: ["session-reviews", session.id, participant?.id],
    queryFn: () => base44.entities.SessionReview.filter({ session_id: session.id, participant_id: participant?.id }),
    enabled: !!participant?.id,
  });
  const myReview = existingReviews[0];

  const submitMut = useMutation({
    mutationFn: () => base44.entities.SessionReview.create({
      event_id: session.event_id,
      session_id: session.id,
      participant_id: participant?.id,
      rating,
      comment: comment.trim() || undefined,
    }),
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["session-reviews", session.id, participant?.id] });
      toast.success("Avaliação enviada!");
      if (participant?.id) {
        await processAction({
          eventId: session.event_id,
          participantId: participant.id,
          personId: participant.person_id,
          acao: "avaliacao_sessao",
          refId: session.id,
        });
        queryClient.invalidateQueries({ queryKey: ["my_participant_points"] });
      }
    },
  });

  if (myReview) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
        <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
        <div>
          <p className="text-sm font-medium">Avaliado: {myReview.rating}/10</p>
          {myReview.comment && <p className="text-xs text-muted-foreground mt-0.5">{myReview.comment}</p>}
        </div>
      </div>
    );
  }

  if (isReadOnly) return <p className="text-xs text-muted-foreground">Evento encerrado.</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium text-muted-foreground">Nota (0–10) *</p>
      <div className="flex flex-wrap gap-1.5">
        {Array.from({ length: 11 }, (_, i) => (
          <button
            key={i}
            onClick={() => setRating(i)}
            className={`w-9 h-9 rounded-xl text-sm font-semibold border transition-colors ${
              rating === i ? "bg-primary text-primary-foreground border-primary" : "border-border hover:border-primary/50"
            }`}
          >
            {i}
          </button>
        ))}
      </div>
      <div className="space-y-1">
        <textarea
          className="w-full rounded-xl border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
          rows={3}
          maxLength={500}
          placeholder="Comentário opcional..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <p className="text-xs text-right text-muted-foreground">{comment.length}/500</p>
      </div>
      <Button className="w-full" disabled={rating === null || submitMut.isPending} onClick={() => submitMut.mutate()}>
        {submitMut.isPending ? "Enviando..." : "Enviar Avaliação"}
      </Button>
    </div>
  );
}

// ── Mentorship ────────────────────────────────────────────────────────────────
function MentorshipSection({ session, participant, isReadOnly }) {
  const queryClient = useQueryClient();
  const { data: existing = [] } = useQuery({
    queryKey: ["mentorship", session.id, participant?.id],
    queryFn: () => base44.entities.MentorshipRequest.filter({ session_id: session.id, participant_id: participant?.id }),
    enabled: !!participant?.id,
  });
  const alreadyRequested = existing.some((r) => r.status !== "cancelled");

  const requestMut = useMutation({
    mutationFn: () => base44.entities.MentorshipRequest.create({
      event_id: session.event_id,
      session_id: session.id,
      participant_id: participant?.id,
      person_id: participant?.person_id,
      mentor_participant_id: session.speaker_id || undefined,
      topic: session.title,
      requested_at: new Date().toISOString(),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mentorship", session.id, participant?.id] });
      toast.success("Solicitação de mentoria enviada!");
    },
  });

  if (alreadyRequested) {
    return (
      <div className="flex items-center gap-2 text-sm text-emerald-600">
        <CheckCircle2 className="w-4 h-4" /> Solicitação enviada ao palestrante.
      </div>
    );
  }

  return (
    <Button variant="outline" className="w-full gap-2" disabled={isReadOnly || requestMut.isPending} onClick={() => requestMut.mutate()}>
      <BookUser className="w-4 h-4" />
      {requestMut.isPending ? "Enviando..." : "Quero Mentoria"}
    </Button>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function SessionDetail({ session, track, room, participant, isReadOnly, onClose }) {
  const queryClient = useQueryClient();
  const participantId = participant?.id;

  const { data: attendances = [], isLoading: loadingAttendance } = useQuery({
    queryKey: ["session-attendance", session.id, participantId],
    queryFn: () => base44.entities.SessionAttendance.filter({ session_id: session.id, participant_id: participantId }),
    enabled: !!participantId,
  });

  const isPresent = attendances.some((a) => a.is_present !== false);

  const togglePresenceMut = useMutation({
    mutationFn: async () => {
      if (isPresent) {
        const att = attendances.find((a) => a.is_present !== false);
        if (att) await base44.entities.SessionAttendance.update(att.id, { is_present: false });
      } else {
        await base44.entities.SessionAttendance.create({
          event_id: session.event_id,
          session_id: session.id,
          participant_id: participantId,
          person_id: participant?.person_id,
          is_present: true,
          registered_at: new Date().toISOString(),
        });
        // Lead para palestrante
        if (session.speaker_name) {
          base44.entities.Lead.create({
            event_id: session.event_id,
            participant_id: participantId,
            participant_name: participant?.full_name || "",
            participant_email: participant?.email || "",
            source: "session",
            notes: `Presença na sessão: ${session.title}`,
          }).catch(() => {});
        }
        // Pontuação
        await processAction({
          eventId: session.event_id,
          participantId,
          personId: participant?.person_id,
          acao: "presenca_sessao",
          refId: session.id,
        });
        queryClient.invalidateQueries({ queryKey: ["my_participant_points"] });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-attendance", session.id, participantId] }),
    onError: (err) => toast.error(err.message || "Erro ao registrar presença."),
  });

  const blocked = !isPresent && !isReadOnly;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
      <div className="w-full sm:max-w-lg bg-background rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div
          className="sticky top-0 bg-background p-4 pb-3 border-b border-border z-10"
          style={track?.color ? { borderTopColor: track.color, borderTopWidth: 4, borderTopLeftRadius: 16, borderTopRightRadius: 16 } : {}}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <p className="font-display font-bold text-base leading-tight">{session.title}</p>
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                {session.start_time && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    {formatTime(session.start_time)}{session.end_time && ` – ${formatTime(session.end_time)}`}
                  </span>
                )}
                {room && <span className="flex items-center gap-1 text-xs text-muted-foreground"><MapPin className="w-3 h-3" />{room.name}</span>}
                {session.speaker_name && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Mic className="w-3 h-3" />{session.speaker_name}</span>}
                {session.session_type && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                    {SESSION_TYPE_LABELS[session.session_type] || session.session_type}
                  </span>
                )}
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted transition-colors shrink-0 mt-0.5">
              <X className="w-5 h-5" />
            </button>
          </div>
          {session.description && (
            <p className="text-sm text-muted-foreground mt-2 line-clamp-3">{session.description}</p>
          )}
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {/* Presença toggle */}
          {!isReadOnly ? (
            <button
              onClick={() => togglePresenceMut.mutate()}
              disabled={togglePresenceMut.isPending || loadingAttendance}
              className={`w-full py-3 rounded-2xl font-semibold text-sm flex items-center justify-center gap-2 transition-all ${
                isPresent
                  ? "bg-emerald-100 text-emerald-700 border-2 border-emerald-400 hover:bg-emerald-200"
                  : "bg-primary text-primary-foreground hover:bg-primary/90 shadow-md"
              }`}
            >
              {togglePresenceMut.isPending ? (
                <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : isPresent ? (
                <><CheckCircle2 className="w-5 h-5" /> Presente! (clique para desfazer)</>
              ) : (
                <><UserCheck className="w-5 h-5" /> Presente! 🙋</>
              )}
            </button>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm">
              <Lock className="w-4 h-4" /> Evento encerrado — modo consulta.
            </div>
          )}

          {/* Recursos da sessão */}
          <Section title="Perguntas e Respostas" icon={MessageCircleQuestion} locked={blocked}>
            <QASection session={session} participant={participant} myParticipantId={participantId} isReadOnly={isReadOnly} />
          </Section>

          {session.material_url && (
            <Section title="Material" icon={Download} locked={blocked}>
              <a href={session.material_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-primary hover:underline">
                <Download className="w-4 h-4" /> Baixar material da sessão
              </a>
            </Section>
          )}

          <Section title="Avaliar Sessão" icon={Star} locked={blocked}>
            <RatingSection session={session} participant={participant} isReadOnly={isReadOnly} />
          </Section>

          <Section title="Solicitar Mentoria" icon={BookOpen} locked={blocked}>
            <MentorshipSection session={session} participant={participant} isReadOnly={isReadOnly} />
          </Section>
        </div>
      </div>
    </div>
  );
}
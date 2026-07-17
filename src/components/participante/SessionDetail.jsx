/**
 * Detalhe de uma sessão para o participante.
 * - Toggle de presença (controla acesso aos recursos)
 * - Foto + info do palestrante + "Patrocinado por" (partner_rep)
 * - Perguntas públicas/particulares
 * - Avaliação com slider 0-10 + comentário
 * - Solicitar mentoria
 * - Baixar material + Enviar por e-mail de contato
 * Motor de pontuação integrado.
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { sendEmail } from "@/lib/apiClient";
import { processAction } from "@/lib/scoringEngine";
import { Button } from "@/components/ui/button";
import {
  X, MessageCircleQuestion, Star, BookUser,
  Download, ThumbsUp, Lock, CheckCircle2, Clock, MapPin, Mic, Send,
  UserCheck, BookOpen, Mail, Building2,
} from "lucide-react";
import { toast } from "sonner";
import { sanitizeText } from "@/utils/sanitize";
import LivePollCard from "@/components/participante/LivePollCard";

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

// ── Speaker card (foto + info + patrocinado por) ──────────────────────────────
function SpeakerCard({ session }) {
  // Buscar person do speaker para foto
  const { data: speakerPerson } = useQuery({
    queryKey: ["speaker-person", session.speaker_id],
    queryFn: async () => {
      if (!session.speaker_id) return null;
      // speaker_id é Participant.id
      const parts = await base44.entities.Participant.filter({ id: session.speaker_id });
      const sp = parts[0];
      if (!sp?.person_id) return null;
      const persons = await base44.entities.Person.filter({ id: sp.person_id });
      return persons[0] ?? null;
    },
    enabled: !!session.speaker_id,
  });

  // Verificar se palestrante é partner_rep
  const { data: partnerRepInfo } = useQuery({
    queryKey: ["speaker-partner-rep", session.speaker_id, session.event_id],
    queryFn: async () => {
      if (!session.speaker_id) return null;
      const parts = await base44.entities.Participant.filter({ id: session.speaker_id });
      const sp = parts[0];
      if (!sp?.person_id || sp.role_in_event !== "partner_rep") return null;

      // Buscar PartnerRepresentative por person_id
      const reps = await base44.entities.PartnerRepresentative.filter({
        person_id: sp.person_id,
        is_active: true,
        is_deleted: false,
      });
      if (!reps.length) return null;

      // Verificar se o partner está vinculado a este evento
      const eventPartners = await base44.entities.EventPartner.filter({
        event_id: session.event_id,
        is_active: true,
        is_deleted: false,
      });
      const rep = reps.find((r) => eventPartners.some((ep) => ep.partner_id === r.partner_id));
      if (!rep) return null;

      const partners = await base44.entities.Partner.filter({ id: rep.partner_id });
      return partners[0] ?? null;
    },
    enabled: !!session.speaker_id,
  });

  if (!session.speaker_name && !speakerPerson) return null;

  const photoUrl = speakerPerson?.photo_url;
  const displayName = session.speaker_name || speakerPerson?.full_name;

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-muted/30 border-b border-border">
      {/* Avatar */}
      <div className="shrink-0">
        {photoUrl ? (
          <img src={photoUrl} alt={displayName} className="w-12 h-12 rounded-full object-cover ring-2 ring-border" />
        ) : (
          <div className="w-12 h-12 rounded-full bg-primary/10 text-primary font-display font-bold text-lg flex items-center justify-center ring-2 ring-border">
            {displayName?.[0]?.toUpperCase() ?? "?"}
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <Mic className="w-3 h-3 text-muted-foreground shrink-0" />
          <p className="text-sm font-medium truncate">{displayName}</p>
        </div>
        {speakerPerson?.company && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {speakerPerson.company}{speakerPerson.job_title ? ` · ${speakerPerson.job_title}` : ""}
          </p>
        )}
      </div>

      {/* Patrocinado por */}
      {partnerRepInfo && (
        <div className="shrink-0 flex flex-col items-center gap-1 text-center">
          <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Patrocinado por</span>
          {partnerRepInfo.logo_url ? (
            <img src={partnerRepInfo.logo_url} alt={partnerRepInfo.trade_name} className="h-8 max-w-[80px] object-contain" />
          ) : (
            <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Building2 className="w-3.5 h-3.5" />
              <span>{partnerRepInfo.trade_name}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Material section (download + email) ──────────────────────────────────────
function MaterialSection({ session, participant }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  // Buscar person para pegar contact_email
  const { data: person } = useQuery({
    queryKey: ["participant-person", participant?.person_id],
    queryFn: async () => {
      if (!participant?.person_id) return null;
      const list = await base44.entities.Person.filter({ id: participant.person_id });
      return list[0] ?? null;
    },
    enabled: !!participant?.person_id,
  });

  const contactEmail = person?.contact_email;

  const handleSendEmail = async () => {
    if (!contactEmail) {
      toast.error("E-mail de contato não cadastrado. Acesse seu perfil e preencha o e-mail de contato.");
      return;
    }
    setSending(true);
    try {
      await sendEmail({
        to: contactEmail,
        subject: `Material da sessão: ${session.title}`,
        body: `Olá${participant?.full_name ? `, ${participant.full_name}` : ""}!\n\nAqui está o material da sessão "${session.title}":\n\n${session.material_url}\n\nBom aprendizado!`,
      });
      setSent(true);
      toast.success(`Material enviado para ${contactEmail}`);
    } catch {
      toast.error("Erro ao enviar e-mail. Tente novamente.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-2">
      <a
        href={session.material_url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 w-full px-4 py-2.5 rounded-xl border border-border bg-muted/30 text-sm font-medium hover:bg-muted/60 transition-colors"
      >
        <Download className="w-4 h-4 text-primary" />
        Baixar material da sessão
      </a>

      {sent ? (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 text-sm">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          Material enviado para {contactEmail}
        </div>
      ) : (
        <button
          onClick={handleSendEmail}
          disabled={sending}
          className="flex items-center gap-2 w-full px-4 py-2.5 rounded-xl border border-border bg-muted/30 text-sm font-medium hover:bg-muted/60 transition-colors disabled:opacity-60"
        >
          {sending ? (
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          ) : (
            <Mail className="w-4 h-4 text-primary" />
          )}
          {sending ? "Enviando..." : "Enviar material por e-mail"}
        </button>
      )}
    </div>
  );
}

// ── Q&A ───────────────────────────────────────────────────────────────────────
function QASection({ session, participant, myParticipantId, isReadOnly }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [visibility, setVisibility] = useState("publica");
  const [replyTexts, setReplyTexts] = useState({});

  const isSpeaker = participant?.role_in_event === "speaker";

  const { data: questions = [] } = useQuery({
    queryKey: ["session-questions", session.id],
    queryFn: () => base44.entities.SessionQuestion.filter({ session_id: session.id, is_deleted: false }),
  });

  const { data: answers = [] } = useQuery({
    queryKey: ["session-answers", session.id],
    queryFn: () => base44.entities.SessionAnswer.filter({ session_id: session.id, is_deleted: false }),
  });

  const answerMap = Object.fromEntries(answers.map((a) => [a.question_id, a]));

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
      question: sanitizeText(text.trim()),
      visibility,
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
    mutationFn: (q) => base44.entities.SessionQuestion.update(q.id, { is_answered: !q.is_answered }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-questions", session.id] }),
  });

  const replyMut = useMutation({
    mutationFn: async ({ question, replyText }) => {
      const existing = answerMap[question.id];
      const safeReply = sanitizeText(replyText);
      if (existing) {
        await base44.entities.SessionAnswer.update(existing.id, { answer_text: safeReply });
      } else {
        await base44.entities.SessionAnswer.create({
          question_id: question.id,
          session_id: session.id,
          event_id: session.event_id,
          speaker_participant_id: participant?.id,
          speaker_person_id: participant?.person_id,
          answer_text: safeReply,
        });
      }
      await base44.entities.SessionQuestion.update(question.id, { is_answered: true });
    },
    onSuccess: (_, { question }) => {
      queryClient.invalidateQueries({ queryKey: ["session-questions", session.id] });
      queryClient.invalidateQueries({ queryKey: ["session-answers", session.id] });
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
        {visibleQuestions.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-3">Nenhuma pergunta ainda.</p>
        )}
        {visibleQuestions.map((q) => {
          const answer = answerMap[q.id];
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

// ── Rating (slider) ───────────────────────────────────────────────────────────
function RatingSection({ session, participant, isReadOnly }) {
  const queryClient = useQueryClient();
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");

  const { data: existingReviews = [] } = useQuery({
    queryKey: ["session-reviews", session.id, participant?.id],
    queryFn: () => base44.entities.SessionReview.filter({ session_id: session.id, participant_id: participant?.id }),
    enabled: !!participant?.id,
  });
  const myReview = existingReviews[0];

  useEffect(() => {
    if (myReview) {
      setRating(myReview.rating);
      setComment(myReview.comment || "");
    }
  }, [myReview]);

  const submitMut = useMutation({
    mutationFn: () => {
      const safeComment = comment.trim() ? sanitizeText(comment.trim()) : undefined;
      if (myReview) {
        return base44.entities.SessionReview.update(myReview.id, {
          rating,
          comment: safeComment,
        });
      }
      return base44.entities.SessionReview.create({
        event_id: session.event_id,
        session_id: session.id,
        participant_id: participant?.id,
        rating,
        comment: safeComment,
      });
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["session-reviews", session.id, participant?.id] });
      toast.success(myReview ? "Avaliação atualizada!" : "Avaliação enviada!");
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

  if (isReadOnly && !myReview) return <p className="text-xs text-muted-foreground">Evento encerrado.</p>;

  return (
    <div className="space-y-4">
      {myReview && (
        <div className="flex items-center gap-2 text-xs text-emerald-600 font-medium">
          <CheckCircle2 className="w-4 h-4" /> Avaliação registrada — você pode atualizar sua nota.
        </div>
      )}
      {/* Slider */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">Nota *</p>
          <span className="text-2xl font-display font-bold text-primary">{rating}<span className="text-sm font-normal text-muted-foreground">/10</span></span>
        </div>
        <input
          type="range"
          min={0}
          max={10}
          step={1}
          value={rating}
          onChange={(e) => setRating(Number(e.target.value))}
          className="w-full h-2 rounded-full appearance-none cursor-pointer accent-primary bg-muted"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>0</span>
          <span>5</span>
          <span>10</span>
        </div>
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
      <Button className="w-full" disabled={submitMut.isPending} onClick={() => submitMut.mutate()}>
        {submitMut.isPending ? "Enviando..." : myReview ? "Atualizar Avaliação" : "Enviar Avaliação"}
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
        // Re-check server-side antes de criar — previne duplicatas de presença
        // (cache stale, duplo-clique rápido, ou múltiplas abas)
        const fresh = await base44.entities.SessionAttendance.filter({
          session_id: session.id, participant_id: participantId,
        });
        if (fresh.some((a) => a.is_present !== false)) {
          queryClient.invalidateQueries({ queryKey: ["session-attendance", session.id, participantId] });
          return;
        }
        await base44.entities.SessionAttendance.create({
          event_id: session.event_id,
          session_id: session.id,
          participant_id: participantId,
          person_id: participant?.person_id,
          is_present: true,
          registered_at: new Date().toISOString(),
        });
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
          className="sticky top-0 bg-background border-b border-border z-10"
          style={track?.color ? { borderTopColor: track.color, borderTopWidth: 4, borderTopLeftRadius: 16, borderTopRightRadius: 16 } : {}}
        >
          <div className="p-4 pb-3">
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

          {/* Speaker card */}
          {session.speaker_name && <SpeakerCard session={session} />}
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

          {/* Enquete ao vivo */}
          {isPresent && <LivePollCard session={session} participant={participant} />}

          {/* Recursos da sessão */}
          <Section title="Perguntas e Respostas" icon={MessageCircleQuestion} locked={blocked}>
            <QASection session={session} participant={participant} myParticipantId={participantId} isReadOnly={isReadOnly} />
          </Section>

          {session.material_url && (
            <Section title="Material da Sessão" icon={Download} locked={blocked}>
              <MaterialSection session={session} participant={participant} />
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
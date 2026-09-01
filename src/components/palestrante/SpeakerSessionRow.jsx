/**
 * Linha de sessão no painel do palestrante com abas: Material | Perguntas | Avaliações | Mentorias | Leads
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { uploadFile } from "@/lib/apiClient";
import { Button } from "@/components/ui/button";
import {
  Clock, ChevronDown, ChevronUp, Upload, MessageCircleQuestion,
  Star, BookUser, Users, ThumbsUp, Send, CheckCircle2, Link as LinkIcon, Radio,
} from "lucide-react";
import { toast } from "sonner";
import PollsTab from "@/components/palestrante/PollsTab";
import SectionSwitcher from "@/components/ui/SectionSwitcher";

function formatTime(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

const SESSION_SECTIONS = [
  { id: "perguntas", label: "Perguntas", icon: MessageCircleQuestion },
  { id: "enquetes", label: "Enquetes", icon: Radio },
  { id: "avaliacoes", label: "Avaliações", icon: Star },
  { id: "mentorias", label: "Mentorias", icon: BookUser },
  { id: "leads", label: "Leads", icon: Users },
  { id: "material", label: "Material", icon: Upload },
];

// ── Tab: Perguntas ────────────────────────────────────────────────────────────
function PerguntasTab({ session, myParticipant }) {
  const queryClient = useQueryClient();
  const [replyTexts, setReplyTexts] = useState({});

  const { data: questions = [] } = useQuery({
    queryKey: ["speaker-questions", session.id],
    queryFn: async () => {
      const res = await base44.functions.invoke('getSessionQuestions', { sessionId: session.id });
      return res.data?.questions || [];
    },
  });

  const markMut = useMutation({
    mutationFn: (q) => base44.functions.invoke('manageSessionQuestion', {
      operation: 'markAnswered',
      questionId: q.id,
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["speaker-questions", session.id] }),
  });

  const replyMut = useMutation({
    mutationFn: ({ question, text }) => base44.functions.invoke('manageSessionAnswer', {
      operation: 'save',
      questionId: question.id,
      answerText: text,
    }),
    onSuccess: (_, { question }) => {
      queryClient.invalidateQueries({ queryKey: ["speaker-questions", session.id] });
      setReplyTexts((prev) => ({ ...prev, [question.id]: "" }));
      toast.success("Resposta enviada!");
    },
  });

  const pendingQ = questions.filter((q) => !q.is_answered);
  const answeredQ = questions.filter((q) => q.is_answered);

  if (!questions.length) {
    return <p className="text-sm text-muted-foreground py-3 text-center">Nenhuma pergunta ainda.</p>;
  }

  return (
    <div className="space-y-2">
      {/* Resumo */}
      <div className="flex gap-4 text-xs text-muted-foreground mb-2">
        <span>Total: <strong className="text-foreground">{questions.length}</strong></span>
        <span>Respondidas: <strong className="text-emerald-600">{answeredQ.length}</strong></span>
        <span>Pendentes: <strong className="text-amber-600">{pendingQ.length}</strong></span>
      </div>

      {questions.map((q) => {
        const answer = q.answer;
        const replyText = replyTexts[q.id] || "";
        return (
          <div key={q.id} className={`rounded-xl border p-3 space-y-2 ${q.is_answered ? "border-emerald-200 bg-emerald-50/40" : "border-border"}`}>
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                    q.visibility === "particular" ? "bg-amber-100 text-amber-700" : "bg-muted text-muted-foreground"
                  }`}>
                    {q.visibility === "particular" ? "🔒 Privada" : "🌐 Pública"}
                  </span>
                  {q.is_answered && <span className="text-[10px] text-emerald-600 font-medium">✓ Respondida</span>}
                </div>
                <p className="text-sm">{q.question}</p>
              </div>
              <button
                onClick={() => markMut.mutate(q)}
                disabled={markMut.isPending}
                className={`shrink-0 p-1.5 rounded-lg transition-colors ${
                  q.is_answered ? "text-emerald-600 bg-emerald-100 hover:bg-emerald-200" : "text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50"
                }`}
                title={q.is_answered ? "Desmarcar respondida" : "Marcar como respondida"}
              >
                <ThumbsUp className="w-4 h-4" />
              </button>
            </div>

            {/* Resposta existente */}
            {answer && (
              <div className="ml-2 pl-3 border-l-2 border-primary/30 text-sm text-muted-foreground">
                <span className="text-[10px] font-medium text-primary uppercase tracking-wide block mb-0.5">Sua resposta</span>
                {answer.answer_text}
              </div>
            )}

            {/* Campo de resposta */}
            <div className="flex gap-2">
              <textarea
                className="flex-1 rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                rows={2}
                placeholder={answer ? "Editar resposta..." : "Responder..."}
                value={replyText}
                onChange={(e) => setReplyTexts((prev) => ({ ...prev, [q.id]: e.target.value }))}
              />
              <Button
                size="sm"
                disabled={!replyText.trim() || replyMut.isPending}
                onClick={() => replyMut.mutate({ question: q, text: replyText.trim() })}
                className="self-end gap-1"
              >
                <Send className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tab: Avaliações (anonimizadas) ────────────────────────────────────────────
function AvaliacoesTab({ session }) {
  const { data: reviews = [] } = useQuery({
    queryKey: ["speaker-reviews-detail", session.id],
    queryFn: () => base44.entities.SessionReview.filter({ session_id: session.id }),
  });

  if (!reviews.length) {
    return <p className="text-sm text-muted-foreground py-3 text-center">Nenhuma avaliação ainda.</p>;
  }

  const avg = (reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length).toFixed(1);
  const dist = Array.from({ length: 11 }, (_, i) => ({
    score: i,
    count: reviews.filter((r) => r.rating === i).length,
  }));
  const maxCount = Math.max(...dist.map((d) => d.count), 1);

  return (
    <div className="space-y-4">
      {/* Resumo */}
      <div className="flex items-center gap-4">
        <div className="text-center">
          <p className="text-3xl font-display font-bold text-primary">{avg}</p>
          <p className="text-xs text-muted-foreground">/10 · {reviews.length} avaliação{reviews.length !== 1 ? "ões" : ""}</p>
        </div>
        {/* Distribuição */}
        <div className="flex-1 flex items-end gap-1 h-12">
          {dist.map(({ score, count }) => (
            <div key={score} className="flex-1 flex flex-col items-center gap-0.5">
              <div
                className="w-full bg-primary/20 rounded-sm"
                style={{ height: `${(count / maxCount) * 40}px`, minHeight: count > 0 ? 2 : 0 }}
              />
              <span className="text-[9px] text-muted-foreground">{score}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Comentários anônimos */}
      <div className="space-y-2">
        {reviews.filter((r) => r.comment).map((r) => (
          <div key={r.id} className="rounded-xl border border-border p-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 font-semibold text-primary text-xs">
                <Star className="w-3 h-3" /> {r.rating}/10
              </span>
              <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full">Anônimo</span>
            </div>
            <p className="text-muted-foreground">{r.comment}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Tab: Mentorias ────────────────────────────────────────────────────────────
function MentoriasTab({ session, myParticipant }) {
  const queryClient = useQueryClient();
  const { data: mentorships = [] } = useQuery({
    queryKey: ["speaker-mentorships-session", session.id, myParticipant?.id],
    queryFn: async () => {
      if (!myParticipant?.id) return [];
      const res = await base44.functions.invoke('getMentorshipRequests', { mentorParticipantId: myParticipant.id, sessionId: session.id });
      return res.data?.mentorshipRequests || [];
    },
    enabled: !!myParticipant?.id,
  });

  const updateMut = useMutation({
    mutationFn: ({ id, status }) => base44.functions.invoke('saveMentorshipRequest', { id, status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["speaker-mentorships-session", session.id, myParticipant?.id] }),
  });

  const STATUS_LABELS = { requested: "Solicitado", accepted: "Aceito", completed: "Atendido", cancelled: "Cancelado" };
  const STATUS_COLORS = {
    requested: "bg-amber-100 text-amber-700",
    accepted: "bg-blue-100 text-blue-700",
    completed: "bg-emerald-100 text-emerald-700",
    cancelled: "bg-muted text-muted-foreground",
  };

  if (!mentorships.length) {
    return <p className="text-sm text-muted-foreground py-3 text-center">Nenhuma mentoria solicitada.</p>;
  }

  return (
    <div className="space-y-2">
      {mentorships.map((m) => (
        <div key={m.id} className="rounded-xl border border-border p-3 flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{m.topic || session.title}</p>
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium mt-1 inline-block ${STATUS_COLORS[m.status]}`}>
              {STATUS_LABELS[m.status] || m.status}
            </span>
          </div>
          {m.status !== "completed" && m.status !== "cancelled" && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1 shrink-0"
              disabled={updateMut.isPending}
              onClick={() => updateMut.mutate({ id: m.id, status: "completed" })}
            >
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> Atendida
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Tab: Leads (presenças) ────────────────────────────────────────────────────
function LeadsTab({ session }) {
  const { data: attendances = [] } = useQuery({
    queryKey: ["speaker-leads-session", session.id],
    queryFn: () => base44.entities.SessionAttendance.filter({ session_id: session.id, is_present: true }),
  });

  const participantIds = [...new Set(attendances.map((a) => a.participant_id))];

  const { data: participants = [] } = useQuery({
    queryKey: ["speaker-leads-participants", participantIds.join(",")],
    queryFn: async () => {
      if (!participantIds.length) return [];
      const all = await base44.entities.Participant.filter({ event_id: session.event_id, is_deleted: false });
      return all.filter((p) => participantIds.includes(p.id));
    },
    enabled: participantIds.length > 0,
  });

  if (!attendances.length) {
    return <p className="text-sm text-muted-foreground py-3 text-center">Nenhuma presença registrada ainda.</p>;
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground mb-2">{attendances.length} presente{attendances.length !== 1 ? "s" : ""}</p>
      {participants.map((p) => (
        <div key={p.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
          <div className="w-7 h-7 rounded-full bg-primary/10 text-primary font-bold text-xs flex items-center justify-center shrink-0">
            {p.full_name?.[0]?.toUpperCase() ?? "?"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate">{p.full_name}</p>
            <p className="text-xs text-muted-foreground truncate">{p.company || p.email}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Tab: Material ─────────────────────────────────────────────────────────────
function MaterialTab({ session }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(session.material_url || "");
  const [uploading, setUploading] = useState(false);

  const saveMut = useMutation({
    mutationFn: async (materialUrl) => {
      const res = await base44.functions.invoke('updateSessionMaterial', {
        sessionId: session.id,
        materialUrl,
      });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["speaker-event-sessions"] });
      toast.success("Material atualizado!");
    },
  });

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploading(true);
    try {
      const { file_url } = await uploadFile(file);
      setUrl(file_url);
      await saveMut.mutateAsync(file_url);
    } catch {
      toast.error("Erro ao enviar arquivo.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      {session.material_url && (
        <a
          href={session.material_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-primary hover:underline"
        >
          <LinkIcon className="w-4 h-4" /> Material atual
        </a>
      )}

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground font-medium">Atualizar por link</p>
        <div className="flex gap-2">
          <input
            type="url"
            className="flex-1 rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="https://..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!url.trim() || saveMut.isPending}
            onClick={() => saveMut.mutate(url.trim())}
          >
            Salvar
          </Button>
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground font-medium">Ou enviar arquivo</p>
        <label className={`flex items-center gap-2 w-full px-4 py-2.5 rounded-xl border border-dashed border-border cursor-pointer hover:bg-muted/40 transition-colors text-sm text-muted-foreground ${uploading ? "opacity-60 pointer-events-none" : ""}`}>
          {uploading ? (
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          ) : (
            <Upload className="w-4 h-4 text-primary" />
          )}
          {uploading ? "Enviando..." : "Clique para selecionar arquivo"}
          <input type="file" className="hidden" onChange={handleFileUpload} />
        </label>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function SpeakerSessionRow({ session, myParticipant, personId, userEmail }) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState("perguntas");

  return (
    <div>
      {/* Session header */}
      <button
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{session.title}</p>
          {session.start_time && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
              <Clock className="w-3 h-3" />
              {formatTime(session.start_time)}{session.end_time ? ` – ${formatTime(session.end_time)}` : ""}
            </span>
          )}
        </div>
        {session.material_url && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium shrink-0">
            Material
          </span>
        )}
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-border bg-muted/10">
          {/* Section switcher */}
          <div className="px-4 pt-3">
            <SectionSwitcher
              sections={SESSION_SECTIONS}
              activeSection={activeTab}
              onSectionChange={setActiveTab}
            />
          </div>

          <div className="bg-background border-t border-border px-4 py-4">
            {activeTab === "perguntas" && <PerguntasTab session={session} myParticipant={myParticipant} />}
            {activeTab === "enquetes" && <PollsTab session={session} myParticipant={myParticipant} />}
            {activeTab === "avaliacoes" && <AvaliacoesTab session={session} />}
            {activeTab === "mentorias" && <MentoriasTab session={session} myParticipant={myParticipant} />}
            {activeTab === "leads" && <LeadsTab session={session} />}
            {activeTab === "material" && <MaterialTab session={session} />}
          </div>
        </div>
      )}
    </div>
  );
}
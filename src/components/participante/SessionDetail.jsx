/**
 * Detalhe de uma sessão para o participante (container — P3 componentização).
 * - Toggle de presença (controla acesso aos recursos)
 * - Foto + info do palestrante + "Patrocinado por" (partner_rep)
 * - Perguntas públicas/particulares
 * - Avaliação com slider 0-10 + comentário
 * - Solicitar mentoria
 * - Baixar material + Enviar por e-mail de contato
 * Motor de pontuação integrado. Seções extraídas em ./sessionDetail/*.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { manageAttendance } from "@/lib/personApi";
import { processAction } from "@/lib/scoringEngine";
import { Button } from "@/components/ui/button";
import {
  X, MessageCircleQuestion, Star, Download, Lock, CheckCircle2, Clock, MapPin, UserCheck, BookOpen,
} from "lucide-react";
import { toast } from "sonner";
import LivePollCard from "@/components/participante/LivePollCard";
import Section from "@/components/participante/sessionDetail/Section";
import SpeakerCard from "@/components/participante/sessionDetail/SpeakerCard";
import MaterialSection from "@/components/participante/sessionDetail/MaterialSection";
import QASection from "@/components/participante/sessionDetail/QASection";
import RatingSection from "@/components/participante/sessionDetail/RatingSection";
import MentorshipSection from "@/components/participante/sessionDetail/MentorshipSection";

function formatTime(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

const SESSION_TYPE_LABELS = {
  aula: "Aula", debate: "Debate", demonstracao: "Demonstração",
  keynote: "Keynote", mesa_redonda: "Mesa redonda", palestra: "Palestra",
  painel: "Painel", simulacao: "Simulação", workshop: "Workshop",
};

export default function SessionDetail({ session, track, room, participant, isReadOnly, onClose }) {
  const queryClient = useQueryClient();
  const participantId = participant?.id;

  // Lote 4 — presença via backend (dedupe, capacidade, Lead e contadores no servidor)
  const { data: attendanceState, isLoading: loadingAttendance } = useQuery({
    queryKey: ["session-attendance", session.id, participantId],
    queryFn: () => manageAttendance({ sessionId: session.id, participantId, action: "status" }),
    enabled: !!participantId,
  });

  const isPresent = !!attendanceState?.isPresent;

  const togglePresenceMut = useMutation({
    mutationFn: async () => {
      await manageAttendance({
        sessionId: session.id,
        participantId,
        action: isPresent ? "unregister" : "register",
      });
      if (!isPresent) {
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
              <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted transition-colors shrink-0 mt-0.5 inline-flex items-center justify-center min-h-[44px] min-w-[44px]">
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
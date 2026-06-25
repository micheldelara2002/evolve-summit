/**
 * Card de enquete ao vivo para o participante na tela de sessão.
 * - Só exibe se o participante tem presença confirmada.
 * - Poll ativa: votação com contador regressivo.
 * - Poll encerrada: resultados consolidados.
 * - 1 resposta por participante (deduplicação por poll_id + person_id).
 * - Atualização em tempo real enquanto live.
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Radio, CheckCircle2, BarChart3, Lock } from "lucide-react";
import { toast } from "sonner";

export default function LivePollCard({ session, participant }) {
  const queryClient = useQueryClient();
  const personId = participant?.person_id;

  // Presença confirmada?
  const { data: attendances = [] } = useQuery({
    queryKey: ["session-attendance-poll", session.id, participant?.id],
    queryFn: () => base44.entities.SessionAttendance.filter({ session_id: session.id, participant_id: participant?.id }),
    enabled: !!participant?.id,
  });
  const isPresent = attendances.some((a) => a.is_present !== false);

  // Polls da sessão (live + closed recentes)
  const { data: polls = [], isLoading } = useQuery({
    queryKey: ["session-polls-participant", session.id],
    queryFn: () => base44.entities.SessionPoll.filter({ session_id: session.id, is_deleted: false }),
    enabled: isPresent,
    refetchInterval: 5000,
  });

  // Realtime: atualizar quando answers mudarem
  useEffect(() => {
    if (!isPresent) return;
    const unsub = base44.entities.SessionPollAnswer.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ["poll-answers-participant"] });
    });
    return unsub;
  }, [isPresent, queryClient]);

  if (!isPresent) {
    return (
      <div className="rounded-2xl border border-border bg-muted/20 p-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Lock className="w-4 h-4" /> Enquete disponível apenas para participantes com presença confirmada nesta sessão.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-border bg-card p-4 space-y-2">
        <div className="h-4 w-32 bg-muted rounded animate-pulse" />
        <div className="h-8 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  // Priorizar: live primeiro, depois closed (mais recente)
  const livePolls = polls.filter((p) => p.status === "live");
  const closedPolls = polls.filter((p) => p.status === "closed");
  const now = new Date();

  // Tratar polls live expiradas como closed
  const effectivelyClosed = livePolls.filter((p) => p.live_ends_at && new Date(p.live_ends_at) < now);
  const activeLive = livePolls.filter((p) => !p.live_ends_at || new Date(p.live_ends_at) >= now);

  const displayPolls = [
    ...activeLive,
    ...effectivelyClosed.map((p) => ({ ...p, status: "closed" })),
    ...closedPolls,
  ].slice(0, 3); // mostrar até 3 (1 live + 2 closed recentes)

  if (displayPolls.length === 0) return null;

  return (
    <div className="space-y-3">
      {displayPolls.map((poll) => (
        <PollView key={poll.id} poll={poll} personId={personId} />
      ))}
    </div>
  );
}

// ── View individual ──────────────────────────────────────────────────────────
function PollView({ poll, personId }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState([]);
  const [submitted, setSubmitted] = useState(false);

  const isLive = poll.status === "live";

  const { data: options = [] } = useQuery({
    queryKey: ["poll-options-participant", poll.id],
    queryFn: () => base44.entities.SessionPollOption.filter({ poll_id: poll.id, is_deleted: false }),
  });

  const { data: myAnswer = [] } = useQuery({
    queryKey: ["poll-my-answer", poll.id, personId],
    queryFn: () => base44.entities.SessionPollAnswer.filter({ poll_id: poll.id, person_id: personId, is_deleted: false }),
    enabled: !!personId,
  });

  const { data: answers = [] } = useQuery({
    queryKey: ["poll-answers-participant", poll.id],
    queryFn: () => base44.entities.SessionPollAnswer.filter({ poll_id: poll.id, is_deleted: false }),
    refetchInterval: isLive ? 2000 : false,
  });

  const alreadyAnswered = myAnswer.length > 0;
  const showResults = !isLive || alreadyAnswered;

  // countdown
  const [remaining, setRemaining] = useState(null);
  useEffect(() => {
    if (!isLive || !poll.live_ends_at) return;
    const tick = () => {
      const diff = Math.max(0, Math.ceil((new Date(poll.live_ends_at) - new Date()) / 1000));
      setRemaining(diff);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isLive, poll.live_ends_at]);

  const submitMut = useMutation({
    mutationFn: async () => {
      await base44.entities.SessionPollAnswer.create({
        poll_id: poll.id,
        person_id: personId,
        selected_option_ids: JSON.stringify(selected),
        answered_at: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      setSubmitted(true);
      queryClient.invalidateQueries({ queryKey: ["poll-my-answer", poll.id, personId] });
      queryClient.invalidateQueries({ queryKey: ["poll-answers-participant", poll.id] });
      toast.success("Resposta enviada.");
    },
    onError: (err) => {
      const msg = (err?.response?.data?.error || err?.message || "").toLowerCase();
      if (msg.includes("duplicate") || msg.includes("unique") || msg.includes("já")) {
        toast.error("Você já respondeu esta enquete.");
        queryClient.invalidateQueries({ queryKey: ["poll-my-answer", poll.id, personId] });
      } else {
        toast.error("Não foi possível enviar. Tente novamente.");
      }
    },
  });

  const toggleOption = (optId) => {
    if (alreadyAnswered || submitted) return;
    if (poll.answer_type === "multiple_choice") {
      setSelected((prev) => {
        if (prev.includes(optId)) return prev.filter((id) => id !== optId);
        if (prev.length >= (poll.max_options || 1)) return prev;
        return [...prev, optId];
      });
    } else {
      setSelected([optId]);
    }
  };

  // Cálculo de resultados
  const voteCounts = {};
  answers.forEach((a) => {
    let ids = [];
    try { ids = JSON.parse(a.selected_option_ids || "[]"); } catch { ids = []; }
    ids.forEach((id) => { voteCounts[id] = (voteCounts[id] || 0) + 1; });
  });
  const totalVotes = Object.values(voteCounts).reduce((s, n) => s + n, 0);
  const sortedOptions = [...options].sort((a, b) => a.position - b.position);

  const mySelectedIds = alreadyAnswered
    ? (() => { try { return JSON.parse(myAnswer[0].selected_option_ids || "[]"); } catch { return []; } })()
    : selected;

  return (
    <div className={`rounded-2xl border p-4 space-y-3 ${isLive ? "border-red-300 bg-red-50/20" : "border-border bg-card"}`}>
      {/* Header */}
      <div className="flex items-center gap-2">
        {isLive ? (
          <span className="flex items-center gap-1.5 text-xs font-medium text-red-600">
            <Radio className="w-3.5 h-3.5 animate-pulse" /> Enquete ao vivo
            {remaining !== null && <span className="font-mono">· ⏱ {remaining}s</span>}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
            <BarChart3 className="w-3.5 h-3.5" /> Resultado final
          </span>
        )}
      </div>

      {/* Pergunta */}
      <p className="text-sm font-semibold">{poll.question}</p>

      {/* Opções / Resultados */}
      {showResults ? (
        <div className="space-y-2">
          {sortedOptions.map((opt) => {
            const count = voteCounts[opt.id] || 0;
            const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
            const isMine = mySelectedIds.includes(opt.id);
            return (
              <div key={opt.id} className="space-y-1">
                <div className="flex justify-between items-center text-sm">
                  <span className="flex items-center gap-1.5">
                    {isMine && <CheckCircle2 className="w-3.5 h-3.5 text-primary" />}
                    {opt.option_text}
                  </span>
                  <span className="font-medium text-xs text-muted-foreground">{count} · {pct}%</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground pt-1">{totalVotes} voto{totalVotes !== 1 ? "s" : ""}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sortedOptions.map((opt) => {
            const isSelected = selected.includes(opt.id);
            return (
              <button
                key={opt.id}
                onClick={() => toggleOption(opt.id)}
                className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm text-left transition-colors ${
                  isSelected
                    ? "border-primary bg-primary/10 text-primary font-medium"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <div className={`w-4 h-4 shrink-0 border-2 rounded flex items-center justify-center ${
                  isSelected ? "border-primary bg-primary" : "border-muted-foreground"
                }`}>
                  {isSelected && <CheckCircle2 className="w-3 h-3 text-primary-foreground" />}
                </div>
                {opt.option_text}
              </button>
            );
          })}

          <Button
            className="w-full"
            disabled={selected.length === 0 || submitMut.isPending}
            onClick={() => submitMut.mutate()}
          >
            {submitMut.isPending ? "Enviando..." : "Enviar resposta"}
          </Button>
          {poll.answer_type === "multiple_choice" && (poll.max_options || 1) > 1 && (
            <p className="text-xs text-muted-foreground text-center">
              Selecione até {poll.max_options} opção{poll.max_options !== 1 ? "ões" : ""}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
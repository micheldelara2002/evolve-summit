/**
 * Aba de Enquetes no painel do palestrante.
 * Criar/editar/excluir rascunhos, Go live, encerrar, ver resultados em tempo real.
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Plus, Pencil, Trash2, Radio, Square, CheckCircle2, BarChart3, XCircle } from "lucide-react";
import { toast } from "sonner";
import PollFormDialog from "@/components/palestrante/PollFormDialog";

const STATUS = {
  draft: { label: "Rascunho", color: "bg-muted text-muted-foreground" },
  live: { label: "Ao vivo", color: "bg-red-100 text-red-700 animate-pulse" },
  closed: { label: "Encerrada", color: "bg-emerald-100 text-emerald-700" },
};

const TYPE_LABELS = { yes_no: "Sim/Não", single_choice: "Simples escolha", multiple_choice: "Múltipla escolha" };

export default function PollsTab({ session, myParticipant }) {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [resultsPollId, setResultsPollId] = useState(null);

  const qKey = ["session-polls", session.id];

  const { data: polls = [] } = useQuery({
    queryKey: qKey,
    queryFn: () => base44.entities.SessionPoll.filter({ session_id: session.id, is_deleted: false }),
  });

  // Auto-encerrar polls expiradas
  useEffect(() => {
    const now = new Date();
    polls.forEach((p) => {
      if (p.status === "live" && p.live_ends_at && new Date(p.live_ends_at) < now) {
        base44.entities.SessionPoll.update(p.id, {
          status: "closed",
          closed_at: new Date().toISOString(),
        }).then(() => queryClient.invalidateQueries({ queryKey: qKey }));
      }
    });
  }, [polls, queryClient, qKey]);

  const createMut = useMutation({
    mutationFn: async ({ data, options }) => {
      const poll = await base44.entities.SessionPoll.create({
        event_id: session.event_id,
        session_id: session.id,
        created_by_person_id: myParticipant?.person_id,
        question: data.question,
        answer_type: data.answer_type,
        max_options: data.max_options,
        duration_seconds: data.duration_seconds,
        status: "draft",
      });
      await base44.entities.SessionPollOption.bulkCreate(
        options.map((text, i) => ({ poll_id: poll.id, option_text: text, position: i }))
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qKey });
      setDialogOpen(false);
      toast.success("Enquete criada!");
    },
    onError: () => toast.error("Erro ao criar enquete."),
  });

  const updateMut = useMutation({
    mutationFn: async ({ poll, data, options }) => {
      await base44.entities.SessionPoll.update(poll.id, {
        question: data.question,
        answer_type: data.answer_type,
        max_options: data.max_options,
        duration_seconds: data.duration_seconds,
      });
      // Recriar opções
      const oldOpts = await base44.entities.SessionPollOption.filter({ poll_id: poll.id, is_deleted: false });
      await base44.entities.SessionPollOption.bulkUpdate(
        oldOpts.map((o) => ({ id: o.id, is_deleted: true }))
      );
      await base44.entities.SessionPollOption.bulkCreate(
        options.map((text, i) => ({ poll_id: poll.id, option_text: text, position: i }))
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qKey });
      setDialogOpen(false);
      toast.success("Enquete atualizada!");
    },
    onError: () => toast.error("Erro ao atualizar."),
  });

  const goLiveMut = useMutation({
    mutationFn: (poll) => {
      const now = new Date();
      return base44.entities.SessionPoll.update(poll.id, {
        status: "live",
        live_started_at: now.toISOString(),
        live_ends_at: new Date(now.getTime() + (poll.duration_seconds || 15) * 1000).toISOString(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qKey });
      toast.success("Enquete ao vivo!");
    },
  });

  const closeMut = useMutation({
    mutationFn: (poll) => base44.entities.SessionPoll.update(poll.id, {
      status: "closed",
      closed_at: new Date().toISOString(),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qKey });
      toast.success("Enquete encerrada.");
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (poll) => {
      await base44.entities.SessionPoll.update(poll.id, { is_deleted: true });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: qKey });
      toast.success("Enquete excluída.");
    },
  });

  const handleSubmit = (formData) => {
    if (editing) {
      updateMut.mutate({ poll: editing, data: formData, options: formData.options });
    } else {
      createMut.mutate({ data: formData, options: formData.options });
    }
  };

  const sorted = [...polls].sort((a, b) => {
    const order = { live: 0, draft: 1, closed: 2 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3);
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{polls.length} enquete{polls.length !== 1 ? "s" : ""}</p>
        <Button size="sm" className="gap-1" onClick={() => { setEditing(null); setDialogOpen(true); }}>
          <Plus className="w-3.5 h-3.5" /> Nova
        </Button>
      </div>

      {polls.length === 0 && (
        <p className="text-sm text-muted-foreground py-6 text-center">
          Nenhuma enquete ainda. Crie uma para interagir com o público.
        </p>
      )}

      {sorted.map((poll) => (
        <PollCard
          key={poll.id}
          poll={poll}
          onEdit={() => { setEditing(poll); setDialogOpen(true); }}
          onDelete={() => deleteMut.mutate(poll)}
          onGoLive={() => goLiveMut.mutate(poll)}
          onClose={() => closeMut.mutate(poll)}
          onShowResults={() => setResultsPollId(poll.id)}
        />
      ))}

      {resultsPollId && (
        <ResultsModal
          pollId={resultsPollId}
          onClose={() => setResultsPollId(null)}
        />
      )}

      <PollFormDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleSubmit}
        editing={editing}
      />
    </div>
  );
}

// ── Card individual ──────────────────────────────────────────────────────────
function PollCard({ poll, onEdit, onDelete, onGoLive, onClose, onShowResults }) {
  const { data: options = [] } = useQuery({
    queryKey: ["poll-options", poll.id],
    queryFn: () => base44.entities.SessionPollOption.filter({ poll_id: poll.id, is_deleted: false }),
  });

  const st = STATUS[poll.status] || STATUS.draft;
  const isLive = poll.status === "live";
  const isDraft = poll.status === "draft";

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

  return (
    <div className={`rounded-xl border p-3 space-y-2 ${isLive ? "border-red-300 bg-red-50/30" : "border-border"}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${st.color}`}>{st.label}</span>
            <span className="text-[10px] text-muted-foreground">{TYPE_LABELS[poll.answer_type]}</span>
            {isLive && remaining !== null && (
              <span className="text-[10px] font-mono text-red-600">⏱ {remaining}s</span>
            )}
          </div>
          <p className="text-sm font-medium">{poll.question}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {options.length} opções · {poll.duration_seconds}s
          </p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {isDraft && (
          <>
            <Button size="sm" variant="outline" className="gap-1" onClick={onEdit}>
              <Pencil className="w-3 h-3" /> Editar
            </Button>
            <Button size="sm" className="gap-1" onClick={onGoLive}>
              <Radio className="w-3 h-3" /> Go live
            </Button>
            <Button size="sm" variant="ghost" className="gap-1 text-destructive" onClick={onDelete}>
              <Trash2 className="w-3 h-3" />
            </Button>
          </>
        )}
        {isLive && (
          <Button size="sm" variant="destructive" className="gap-1" onClick={onClose}>
            <XCircle className="w-3 h-3" /> Encerrar
          </Button>
        )}
        {!isDraft && (
          <Button size="sm" variant="outline" className="gap-1" onClick={onShowResults}>
            <BarChart3 className="w-3 h-3" /> Resultados
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Modal de resultados ──────────────────────────────────────────────────────
function ResultsModal({ pollId, onClose }) {
  const queryClient = useQueryClient();
  const { data: poll } = useQuery({
    queryKey: ["poll", pollId],
    queryFn: async () => {
      const list = await base44.entities.SessionPoll.filter({ id: pollId });
      return list[0];
    },
    enabled: !!pollId,
  });

  const { data: options = [] } = useQuery({
    queryKey: ["poll-options", pollId],
    queryFn: () => base44.entities.SessionPollOption.filter({ poll_id: pollId, is_deleted: false }),
  });

  const { data: answers = [] } = useQuery({
    queryKey: ["poll-answers", pollId],
    queryFn: () => base44.entities.SessionPollAnswer.filter({ poll_id: pollId, is_deleted: false }),
    refetchInterval: poll?.status === "live" ? 2000 : false,
  });

  // realtime
  useEffect(() => {
    if (!pollId) return;
    const unsub = base44.entities.SessionPollAnswer.subscribe(() => {
      queryClient.invalidateQueries({ queryKey: ["poll-answers", pollId] });
    });
    return unsub;
  }, [pollId]);

  const totalVoters = answers.length;
  const voteCounts = {};
  answers.forEach((a) => {
    let ids = [];
    try { ids = JSON.parse(a.selected_option_ids || "[]"); } catch { ids = []; }
    ids.forEach((id) => { voteCounts[id] = (voteCounts[id] || 0) + 1; });
  });
  const totalVotes = Object.values(voteCounts).reduce((s, n) => s + n, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-background rounded-2xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-display font-bold text-base">Resultados</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-muted"><XCircle className="w-4 h-4" /></button>
        </div>
        {poll && <p className="text-sm text-muted-foreground">{poll.question}</p>}

        <div className="text-xs text-muted-foreground">
          {totalVoters} participante{totalVoters !== 1 ? "s" : ""} · {totalVotes} voto{totalVotes !== 1 ? "s" : ""}
        </div>

        <div className="space-y-2">
          {options.sort((a, b) => a.position - b.position).map((opt) => {
            const count = voteCounts[opt.id] || 0;
            const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
            return (
              <div key={opt.id} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span>{opt.option_text}</span>
                  <span className="font-medium">{count} ({pct}%)</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          {options.length === 0 && <p className="text-sm text-muted-foreground">Sem opções.</p>}
        </div>
      </div>
    </div>
  );
}
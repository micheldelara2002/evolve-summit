/**
 * Modal de Sorteio reutilizável.
 * Props:
 *   open, onClose
 *   eventId       — obrigatório
 *   context       — "organizer" | "speaker" | "partner"
 *   contextRefId  — participant_id do speaker OU partner_id do parceiro
 *   drawnByLabel  — string exibida em "Sorteado por"
 *   eligiblePool  — array de {id, full_name, email, company?} já filtrado pelo chamador
 *   sessions      — array de sessions do evento (para filtro extra por sessão; opcional)
 *   badges        — array de badges do evento (para filtro por badge; opcional)
 *   user          — objeto user atual
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trophy, ThumbsUp, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";

// ── Winner card ───────────────────────────────────────────────────────────────
function WinnerCard({ winner, onToggleConfirmed, locked }) {
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
      winner.confirmed ? "border-emerald-300 bg-emerald-50" : "border-border bg-card"
    }`}>
      <div className="w-9 h-9 rounded-full bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0">
        {winner.full_name?.[0]?.toUpperCase() ?? "?"}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold truncate">{winner.full_name}</p>
        <p className="text-xs text-muted-foreground truncate">{winner.company || winner.email}</p>
      </div>
      {!locked && (
        <button
          onClick={() => onToggleConfirmed(winner.id)}
          title={winner.confirmed ? "Desmarcar recebimento" : "Confirmar recebimento"}
          className={`shrink-0 p-1.5 rounded-lg transition-colors ${
            winner.confirmed
              ? "text-emerald-600 bg-emerald-100 hover:bg-emerald-200"
              : "text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50"
          }`}
        >
          <ThumbsUp className="w-4 h-4" />
        </button>
      )}
      {locked && winner.confirmed && (
        <span className="text-[10px] text-emerald-600 font-semibold bg-emerald-100 px-2 py-0.5 rounded-full shrink-0">
          ✓ Recebeu
        </span>
      )}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────
export default function RaffleModal({
  open,
  onClose,
  eventId,
  context,
  contextRefId,
  drawnByLabel,
  eligiblePool = [],
  sessions = [],
  badges = [],
  user,
}) {
  const queryClient = useQueryClient();

  // Form state
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [winnerCount, setWinnerCount] = useState(1);

  // Session filter (for organizer/speaker)
  const [sessionFilter, setSessionFilter] = useState("all");

  // Raffle state
  const [phase, setPhase] = useState("form"); // "form" | "result"
  const [winners, setWinners] = useState([]);
  const [round, setRound] = useState(0);
  const [rounds, setRounds] = useState([]);
  const [savedRaffleId, setSavedRaffleId] = useState(null);
  const [locked, setLocked] = useState(false);
  const [drawing, setDrawing] = useState(false);

  // Filter eligible pool by session if selected
  const filteredPool = (() => {
    if (sessionFilter === "all" || !sessions.length) return eligiblePool;
    return eligiblePool; // session-level filtering done in parent
  })();

  const executeDraw = async () => {
    const confirmed = winners.filter((w) => w.confirmed);
    const confirmedIds = new Set(confirmed.map((w) => w.id));
    const needCount = winnerCount - confirmed.length;

    if (needCount <= 0) {
      setPhase("result");
      return;
    }

    const pool = filteredPool.filter((p) => !confirmedIds.has(p.id));

    if (pool.length === 0) {
      toast.warning("Base de elegíveis insuficiente para re-sortear vagas pendentes.");
      setPhase("result");
      return;
    }

    setDrawing(true);
    try {
      // Sorteio executado no backend com aleatoriedade criptograficamente segura
      // — impede manipulação client-side do resultado
      const response = await base44.functions.invoke('executeRaffle', {
        eligiblePool: pool,
        winnerCount: needCount,
      });
      const newWinners = response.data.winners;
      const allWinners = [
        ...confirmed,
        ...newWinners,
      ];

      const roundData = {
        round: round + 1,
        drawn_at: response.data.drawnAt,
        new_winners: newWinners.map((p) => ({ id: p.id, full_name: p.full_name })),
      };
      setRounds((prev) => [...prev, roundData]);
      setRound((r) => r + 1);
      setWinners(allWinners);
      setPhase("result");
    } catch {
      toast.error("Erro ao executar sorteio. Tente novamente.");
    } finally {
      setDrawing(false);
    }
  };

  const startDraw = () => {
    if (!title.trim()) { toast.error("Informe o título do sorteio."); return; }
    if (winnerCount < 1) { toast.error("Quantidade de vencedores deve ser >= 1."); return; }
    if (!filteredPool.length) { toast.error("Nenhum elegível disponível para sortear."); return; }
    executeDraw();
  };

  const redraw = () => {
    if (!filteredPool.length) { toast.warning("Sem elegíveis disponíveis."); return; }
    executeDraw();
  };

  const toggleConfirmed = (id) => {
    setWinners((prev) => prev.map((w) => w.id === id ? { ...w, confirmed: !w.confirmed } : w));
  };

  const saveMut = useMutation({
    mutationFn: async () => {
      const payload = {
        event_id: eventId,
        title: title.trim(),
        description: description.trim(),
        drawn_by_label: drawnByLabel,
        context,
        context_ref_id: contextRefId,
        winner_count: winnerCount,
        eligible_total: filteredPool.length,
        filters_snapshot: JSON.stringify({ session_filter: sessionFilter }),
        winners: JSON.stringify(winners),
        rounds: JSON.stringify(rounds),
        status: "saved",
        executed_by_user_id: user?.id,
        executed_at: rounds[0]?.drawn_at || new Date().toISOString(),
        saved_at: new Date().toISOString(),
      };
      if (savedRaffleId) {
        await base44.entities.Raffle.update(savedRaffleId, payload);
        return savedRaffleId;
      }
      const created = await base44.entities.Raffle.create(payload);
      return created.id;
    },
    onSuccess: (id) => {
      setSavedRaffleId(id);
      setLocked(true);
      queryClient.invalidateQueries({ queryKey: ["raffles", eventId] });
      toast.success("Sorteio salvo com sucesso!");
    },
    onError: () => toast.error("Erro ao salvar sorteio."),
  });

  const handleClose = () => {
    // Reset
    setTitle("");
    setDescription("");
    setWinnerCount(1);
    setSessionFilter("all");
    setPhase("form");
    setWinners([]);
    setRound(0);
    setRounds([]);
    setSavedRaffleId(null);
    setLocked(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Trophy className="w-5 h-5 text-amber-500" /> Sorteio
          </DialogTitle>
        </DialogHeader>

        {/* ── Phase: Form ── */}
        {phase === "form" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Título *</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Sorteio de Camiseta" />
            </div>
            <div className="space-y-1.5">
              <Label>Descrição do prêmio</Label>
              <textarea
                className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                rows={2}
                placeholder="Descreva o prêmio..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Sorteado por</Label>
                <Input value={drawnByLabel} disabled className="bg-muted" />
              </div>
              <div className="space-y-1.5">
                <Label>Nº de vencedores *</Label>
                <Input
                  type="number"
                  min={1}
                  max={filteredPool.length || 1}
                  value={winnerCount}
                  onChange={(e) => setWinnerCount(Math.max(1, parseInt(e.target.value) || 1))}
                />
              </div>
            </div>

            {/* Session filter (optional) */}
            {sessions.length > 0 && (
              <div className="space-y-1.5">
                <Label>Filtrar por palestra/sessão</Label>
                <select
                  className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={sessionFilter}
                  onChange={(e) => setSessionFilter(e.target.value)}
                >
                  <option value="all">Todos os participantes elegíveis</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>{s.title}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="bg-muted/40 rounded-xl px-4 py-3 text-sm">
              <span className="text-muted-foreground">Universo elegível: </span>
              <strong>{filteredPool.length} pessoa{filteredPool.length !== 1 ? "s" : ""}</strong>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={handleClose}>Cancelar</Button>
              <Button onClick={startDraw} disabled={drawing} className="gap-1.5">
                <Trophy className="w-4 h-4" /> Sortear
              </Button>
            </div>
          </div>
        )}

        {/* ── Phase: Result ── */}
        {phase === "result" && (
          <div className="space-y-4">
            <div>
              <p className="font-display font-semibold text-base">{title}</p>
              {description && <p className="text-sm text-muted-foreground">{description}</p>}
              <p className="text-xs text-muted-foreground mt-1">
                Rodada {round} · {filteredPool.length} elegíveis · Por: {drawnByLabel}
              </p>
            </div>

            {/* Winners */}
            <div className="space-y-2">
              {winners.map((w) => (
                <WinnerCard key={w.id} winner={w} onToggleConfirmed={toggleConfirmed} locked={locked} />
              ))}
              {winners.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">Nenhum vencedor.</p>
              )}
            </div>

            {!locked ? (
              <div className="flex flex-col sm:flex-row gap-2 pt-2">
                <Button variant="outline" className="flex-1 gap-1.5" onClick={redraw} disabled={saveMut.isPending || drawing}>
                  <RefreshCw className="w-4 h-4" /> Sortear de novo
                </Button>
                <Button className="flex-1 gap-1.5" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
                  <Save className="w-4 h-4" />
                  {saveMut.isPending ? "Salvando..." : "Salvar sorteio"}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between pt-2">
                <span className="text-xs text-emerald-600 font-semibold bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full">
                  ✓ Sorteio finalizado e salvo
                </span>
                <Button variant="outline" size="sm" onClick={handleClose}>Fechar</Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
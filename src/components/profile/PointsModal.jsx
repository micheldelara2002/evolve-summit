/**
 * Modal de extrato de pontos consolidado por evento.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Star, ChevronRight } from "lucide-react";

const ACAO_LABELS = {
  presenca_sessao: "Presença em sessão",
  avaliacao_sessao: "Avaliação de sessão",
  pergunta_valida: "Pergunta enviada",
  completude_perfil: "Completude do perfil",
  conexao_aceita: "Conexão aceita",
  visita_estande: "Visita ao estande",
  resgate_realizado: "Resgate realizado",
};

function formatDateTime(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function PointsModal({ open, onClose, personId, userEmail }) {
  const { data: participants = [], isLoading: loadingParts } = useQuery({
    queryKey: ["profile-participants", personId, userEmail],
    queryFn: async () => {
      const all = await base44.entities.Participant.filter({ is_deleted: false });
      return all.filter((p) => p.person_id === personId || p.email === userEmail);
    },
    enabled: open && (!!personId || !!userEmail),
  });

  const participantIds = participants.map((p) => p.id);

  const { data: transactions = [], isLoading: loadingTx } = useQuery({
    queryKey: ["profile-point-transactions", participantIds.join(",")],
    queryFn: async () => {
      if (!participantIds.length) return [];
      const all = await base44.entities.PointTransaction.filter({});
      return all.filter((t) => participantIds.includes(t.participant_id));
    },
    enabled: open && participantIds.length > 0,
  });

  const { data: events = [] } = useQuery({
    queryKey: ["profile-events-list"],
    queryFn: () => base44.entities.Event.filter({ is_deleted: false }),
    enabled: open,
  });

  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]));

  // Agrupar transações por evento
  const byEvent = {};
  transactions.forEach((tx) => {
    if (!byEvent[tx.event_id]) byEvent[tx.event_id] = [];
    byEvent[tx.event_id].push(tx);
  });

  const totalGeral = transactions.reduce((s, t) => s + (t.pontos > 0 ? t.pontos : 0), 0);

  const isLoading = loadingParts || loadingTx;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <Star className="w-5 h-5 text-primary" /> Meus Pontos
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : transactions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            Nenhum ponto registrado ainda.
          </div>
        ) : (
          <div className="space-y-4">
            {/* Total geral */}
            <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-primary/10 border border-primary/20">
              <span className="text-sm font-medium">Total acumulado</span>
              <span className="text-lg font-display font-bold text-primary">{totalGeral} pts</span>
            </div>

            {/* Por evento */}
            {Object.entries(byEvent).map(([eventId, txs]) => {
              const ev = eventMap[eventId];
              const eventTotal = txs.reduce((s, t) => s + (t.pontos > 0 ? t.pontos : 0), 0);
              const sorted = [...txs].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
              return (
                <div key={eventId} className="rounded-xl border border-border overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40">
                    <span className="text-sm font-semibold truncate">{ev?.name || "Evento"}</span>
                    <span className="text-sm font-bold text-primary shrink-0 ml-2">{eventTotal} pts</span>
                  </div>
                  <div className="divide-y divide-border">
                    {sorted.map((tx) => (
                      <div key={tx.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{ACAO_LABELS[tx.acao] || tx.acao}</p>
                          {tx.descricao && <p className="text-xs text-muted-foreground truncate">{tx.descricao}</p>}
                          <p className="text-xs text-muted-foreground">{formatDateTime(tx.created_date)}</p>
                        </div>
                        <span className={`shrink-0 ml-3 font-semibold ${tx.pontos >= 0 ? "text-emerald-600" : "text-destructive"}`}>
                          {tx.pontos >= 0 ? "+" : ""}{tx.pontos} pts
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
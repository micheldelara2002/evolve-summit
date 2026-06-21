/**
 * Modal de histórico de resgates consolidado por evento.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ShoppingBag, Star } from "lucide-react";

const STATUS_LABELS = {
  pendente: "Pendente",
  entregue: "Entregue",
  cancelado: "Cancelado",
};
const STATUS_COLORS = {
  pendente: "bg-amber-100 text-amber-700",
  entregue: "bg-emerald-100 text-emerald-700",
  cancelado: "bg-muted text-muted-foreground",
};

function formatDateTime(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function ResgatesModal({ open, onClose, personId, userEmail }) {
  const { data: participants = [], isLoading: loadingParts } = useQuery({
    queryKey: ["profile-participants-res", personId, userEmail],
    queryFn: async () => {
      const all = await base44.entities.Participant.filter({ is_deleted: false });
      return all.filter((p) => p.person_id === personId || p.email === userEmail);
    },
    enabled: open && (!!personId || !!userEmail),
  });

  const participantIds = participants.map((p) => p.id);

  const { data: redemptions = [], isLoading: loadingRes } = useQuery({
    queryKey: ["profile-redemptions", participantIds.join(",")],
    queryFn: async () => {
      if (!participantIds.length) return [];
      const all = await base44.entities.StoreRedemption.filter({ is_deleted: false });
      return all.filter((r) => participantIds.includes(r.participant_id));
    },
    enabled: open && participantIds.length > 0,
  });

  const { data: events = [] } = useQuery({
    queryKey: ["profile-events-list"],
    queryFn: () => base44.entities.Event.filter({ is_deleted: false }),
    enabled: open,
  });

  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]));

  // Agrupar por evento
  const byEvent = {};
  redemptions.forEach((r) => {
    if (!byEvent[r.event_id]) byEvent[r.event_id] = [];
    byEvent[r.event_id].push(r);
  });

  const totalPontos = redemptions.reduce((s, r) => s + (r.pontos_debitados || 0), 0);

  const isLoading = loadingParts || loadingRes;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-primary" /> Meus Resgates
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : redemptions.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            Nenhum resgate realizado ainda.
          </div>
        ) : (
          <div className="space-y-4">
            {/* Total geral */}
            <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-muted/40 border border-border">
              <span className="text-sm font-medium">Total debitado</span>
              <span className="flex items-center gap-1 text-sm font-bold text-muted-foreground">
                <Star className="w-3.5 h-3.5" /> {totalPontos} pts
              </span>
            </div>

            {/* Por evento */}
            {Object.entries(byEvent).map(([eventId, items]) => {
              const ev = eventMap[eventId];
              const sorted = [...items].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
              return (
                <div key={eventId} className="rounded-xl border border-border overflow-hidden">
                  <div className="px-4 py-2.5 bg-muted/40">
                    <span className="text-sm font-semibold">{ev?.name || "Evento"}</span>
                  </div>
                  <div className="divide-y divide-border">
                    {sorted.map((r) => (
                      <div key={r.id} className="flex items-start justify-between px-4 py-3 text-sm gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate">{r.item_description || "Item"}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{formatDateTime(r.created_date)}</p>
                        </div>
                        <div className="shrink-0 flex flex-col items-end gap-1">
                          <span className="flex items-center gap-1 font-semibold text-destructive text-xs">
                            <Star className="w-3 h-3" /> -{r.pontos_debitados} pts
                          </span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[r.status] || "bg-muted text-muted-foreground"}`}>
                            {STATUS_LABELS[r.status] || r.status}
                          </span>
                        </div>
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
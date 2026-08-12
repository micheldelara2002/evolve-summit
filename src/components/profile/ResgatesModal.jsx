/**
 * Modal de histórico de resgates consolidado por evento.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ShoppingBag, Star, Loader2 } from "lucide-react";
import { useCursorPagination } from "@/hooks/useCursorPagination";

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
  // P0: Server-side filtered participants (by person_id OR email, merged + deduped)
  const { data: participants = [], isLoading: loadingParts } = useQuery({
    queryKey: ["profile-participants-res", personId, userEmail],
    queryFn: async () => {
      const [byPerson, byEmail] = await Promise.all([
        personId ? base44.entities.Participant.filter({ person_id: personId, is_deleted: false }) : [],
        userEmail ? base44.entities.Participant.filter({ email: userEmail, is_deleted: false }) : [],
      ]);
      const map = new Map();
      [...byPerson, ...byEmail].forEach((p) => map.set(p.id, p));
      return Array.from(map.values());
    },
    enabled: open && (!!personId || !!userEmail),
  });

  const participantIds = participants.map((p) => p.id);

  // P0: Cursor-based pagination for StoreRedemption ledger — deterministic (created_date, id) cursor
  const { items: redemptions, loading: loadingRes, hasMore, loadMore } = useCursorPagination({
    fetchPage: (query, sort, limit) => base44.entities.StoreRedemption.filter(query, sort, limit),
    baseQuery: { participant_id: { $in: participantIds }, is_deleted: false },
    depsKey: `${open}:${participantIds.join(",")}`,
    enabled: open && participantIds.length > 0,
  });

  // P0: Load only events referenced by loaded redemptions (server-side by id)
  const eventIds = [...new Set(redemptions.map((r) => r.event_id))];
  const { data: events = [] } = useQuery({
    queryKey: ["profile-events-by-res", eventIds.join(",")],
    queryFn: async () => {
      if (!eventIds.length) return [];
      return base44.entities.Event.filter({ id: { $in: eventIds }, is_deleted: false });
    },
    enabled: eventIds.length > 0,
  });

  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]));

  // Agrupar por evento
  const byEvent = {};
  redemptions.forEach((r) => {
    if (!byEvent[r.event_id]) byEvent[r.event_id] = [];
    byEvent[r.event_id].push(r);
  });

  // P0: Total from atomic counter (redeemed_total) — no need to load all redemptions
  const totalPontos = participants.reduce((s, p) => s + (p.redeemed_total || 0), 0);

  const isLoading = loadingParts || (loadingRes && redemptions.length === 0);

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

            {/* P0: Cursor pagination — load more */}
            {hasMore && (
              <button
                onClick={loadMore}
                disabled={loadingRes}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-border text-sm text-muted-foreground hover:bg-muted/40 transition-colors disabled:opacity-60"
              >
                {loadingRes ? <Loader2 className="w-4 h-4 animate-spin" /> : "Carregar mais"}
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
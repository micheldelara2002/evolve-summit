/**
 * Card de badges por evento no perfil do usuário.
 * Badges conquistadas: coloridas. Não conquistadas: cinza.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

function BadgePill({ badge, unlocked }) {
  return (
    <div
      title={unlocked ? badge.titulo : `Bloqueada — Meta: ${badge.valor_meta}`}
      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-all ${
        unlocked
          ? "border-primary/30 bg-primary/5 text-foreground"
          : "border-border bg-muted/30 text-muted-foreground opacity-50"
      }`}
    >
      <span className="text-base">{badge.icone_emoji || "🏅"}</span>
      <div>
        <p className="font-semibold leading-none">{badge.titulo}</p>
        <p className="text-[10px] opacity-70 mt-0.5">{badge.categoria}</p>
      </div>
      {unlocked && <span className="ml-auto text-emerald-600 text-[10px] font-bold">✓</span>}
    </div>
  );
}

export default function BadgesEventCard({ eventId, participantId }) {
  const { data: badges = [] } = useQuery({
    queryKey: ["badges-event", eventId],
    queryFn: () => base44.entities.Badge.filter({ event_id: eventId, ativo: true, is_deleted: false }),
  });

  const { data: event } = useQuery({
    queryKey: ["event-mini", eventId],
    queryFn: async () => {
      const list = await base44.entities.Event.filter({ id: eventId });
      return list[0];
    },
  });

  const { data: transactions = [] } = useQuery({
    queryKey: ["point-transactions-badges", eventId, participantId],
    queryFn: () => base44.entities.PointTransaction.filter({ event_id: eventId, participant_id: participantId }),
    enabled: !!participantId,
  });

  if (!badges.length) return null;

  // Avaliar quais badges foram desbloqueadas com base em transações
  function isUnlocked(badge) {
    if (!badge.criterio_tipo || !badge.acao_referencia) return false;
    const relevant = transactions.filter((t) => t.acao === badge.acao_referencia);

    if (badge.criterio_tipo === "first") return relevant.length >= 1;
    if (badge.criterio_tipo === "count") return relevant.length >= (badge.valor_meta || 1);
    if (badge.criterio_tipo === "points_total") {
      const total = transactions.reduce((s, t) => s + (t.pontos || 0), 0);
      return total >= (badge.valor_meta || 0);
    }
    return false;
  }

  const unlockedIds = new Set(badges.filter(isUnlocked).map((b) => b.id));
  const sorted = [...badges].sort((a, b) => (unlockedIds.has(b.id) ? 1 : 0) - (unlockedIds.has(a.id) ? 1 : 0));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold">{event?.name || eventId}</p>
        <span className="text-xs text-muted-foreground">
          {unlockedIds.size}/{badges.length} conquistada{unlockedIds.size !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {sorted.map((badge) => (
          <BadgePill key={badge.id} badge={badge} unlocked={unlockedIds.has(badge.id)} />
        ))}
      </div>
    </div>
  );
}
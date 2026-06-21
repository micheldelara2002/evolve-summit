/**
 * Visualização de badges/conquistas para o participante.
 * Badges não conquistadas: escala de cinza.
 * Badges conquistadas: coloridas.
 * (Lógica de conquista real a ser conectada — por ora usa placeholder)
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Trophy } from "lucide-react";

const CAT_LABELS = {
  engajamento: "Engajamento",
  conteudo: "Conteúdo",
  networking: "Networking",
};

const COL_LABELS = {
  partindo: "🚀 Partindo",
  aquecendo: "🔥 Aquecendo",
  acelerando: "⚡ Acelerando",
  voando: "🦅 Voando",
};

const COLUNAS = ["partindo", "aquecendo", "acelerando", "voando"];
const CATEGORIAS = ["engajamento", "conteudo", "networking"];

function BadgeCard({ badge, earned }) {
  return (
    <div
      className={`rounded-xl border p-3 flex flex-col items-center gap-1.5 min-h-[110px] transition-all
        ${earned ? "border-border bg-card shadow-sm" : "border-border bg-muted/30"}`}
    >
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center text-2xl transition-all"
        style={{
          backgroundColor: earned ? (badge.icone_cor || "#6366f1") + "22" : "#e5e7eb",
          filter: earned ? "none" : "grayscale(1)",
          opacity: earned ? 1 : 0.5,
        }}
      >
        {badge.icone_emoji || "🏅"}
      </div>
      <p className={`text-xs font-medium text-center leading-tight ${earned ? "text-foreground" : "text-muted-foreground"}`}>
        {badge.titulo}
      </p>
      {earned && (
        <span className="inline-flex px-1.5 py-0.5 rounded-full text-[9px] font-semibold bg-emerald-100 text-emerald-700">
          Conquistada!
        </span>
      )}
    </div>
  );
}

export default function ConquistasView({ eventId, userEmail, myPerson }) {
  const { data: badges = [], isLoading } = useQuery({
    queryKey: ["badges", eventId],
    queryFn: () => base44.entities.Badge.filter({ event_id: eventId, is_deleted: false, ativo: true }),
  });

  // Placeholder: no real earned badges yet — all shown as unearned for now
  // TODO: connect to real scoring/achievement engine
  const earnedBadgeIds = new Set();

  const getCell = (cat, col) => badges.find((b) => b.categoria === cat && b.coluna_progresso === col);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (badges.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Trophy className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p>Nenhuma conquista configurada para este evento.</p>
      </div>
    );
  }

  const earned = badges.filter((b) => earnedBadgeIds.has(b.id)).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-display font-semibold">Minhas Conquistas</h2>
        <span className="text-sm text-muted-foreground">
          {earned} / {badges.length} conquistadas
        </span>
      </div>

      <div className="overflow-x-auto">
        <div className="min-w-[540px]">
          {/* Column headers */}
          <div className="grid grid-cols-[120px_1fr_1fr_1fr_1fr] gap-2 mb-2">
            <div />
            {COLUNAS.map((col) => (
              <div key={col} className="text-center">
                <span className="text-xs font-semibold text-muted-foreground">{COL_LABELS[col]}</span>
              </div>
            ))}
          </div>

          {/* Rows by category */}
          {CATEGORIAS.map((cat) => (
            <div key={cat} className="grid grid-cols-[120px_1fr_1fr_1fr_1fr] gap-2 mb-2">
              <div className="flex items-center justify-center rounded-xl border border-border bg-muted/40 p-2">
                <span className="text-xs font-semibold text-muted-foreground text-center">{CAT_LABELS[cat]}</span>
              </div>
              {COLUNAS.map((col) => {
                const badge = getCell(cat, col);
                if (!badge) {
                  return (
                    <div key={col} className="rounded-xl border-2 border-dashed border-border min-h-[110px] flex items-center justify-center">
                      <span className="text-muted-foreground/30 text-xs">—</span>
                    </div>
                  );
                }
                return (
                  <BadgeCard key={col} badge={badge} earned={earnedBadgeIds.has(badge.id)} />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
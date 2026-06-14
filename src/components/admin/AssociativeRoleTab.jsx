/**
 * Tab associativa genérica: lista participantes e permite associar/remover um papel (role_in_event).
 * Props:
 *   participants: todos os participantes do evento
 *   role: string — papel a gerenciar (ex: "speaker", "team")
 *   roleLabel: string — label pt-BR do papel
 *   hasAccess: bool
 *   onToggle: (participant) => void
 *   description: string — descrição exibida no topo
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

export default function AssociativeRoleTab({ participants, role, roleLabel, hasAccess, onToggle, description }) {
  const [search, setSearch] = useState("");

  const filtered = participants.filter((p) =>
    p.full_name?.toLowerCase().includes(search.toLowerCase()) ||
    p.email?.toLowerCase().includes(search.toLowerCase())
  );

  const inRole = filtered.filter((p) => p.role_in_event === role);
  const others = filtered.filter((p) => p.role_in_event !== role);

  return (
    <div className="space-y-3">
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      <input
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        placeholder="Buscar participante..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {/* Com o papel */}
      {inRole.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{roleLabel} ({inRole.length})</p>
          {inRole.map((p) => (
            <RoleRow key={p.id} participant={p} isInRole={true} roleLabel={roleLabel} hasAccess={hasAccess} onToggle={onToggle} />
          ))}
        </div>
      )}

      {/* Outros participantes (podem ser associados) */}
      {others.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Outros participantes ({others.length})</p>
          {others.map((p) => (
            <RoleRow key={p.id} participant={p} isInRole={false} roleLabel={roleLabel} hasAccess={hasAccess} onToggle={onToggle} />
          ))}
        </div>
      )}

      {filtered.length === 0 && (
        <p className="text-center text-muted-foreground py-6 text-sm">{t("common.noData")}</p>
      )}
    </div>
  );
}

function RoleRow({ participant, isInRole, roleLabel, hasAccess, onToggle }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-border bg-card">
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{participant.full_name}</p>
        <p className="text-xs text-muted-foreground truncate">{participant.email}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isInRole && (
          <Badge className="bg-indigo-100 text-indigo-700 text-xs">{roleLabel}</Badge>
        )}
        {hasAccess && (
          <Button
            variant={isInRole ? "destructive" : "outline"}
            size="sm"
            className="text-xs h-7"
            onClick={() => onToggle(participant)}
          >
            {isInRole ? "Remover" : `Tornar ${roleLabel}`}
          </Button>
        )}
      </div>
    </div>
  );
}
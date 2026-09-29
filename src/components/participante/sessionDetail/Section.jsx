/**
 * Wrapper de seção do detalhe da sessão — conteúdo travado até registrar
 * presença (locked).
 */
import { Lock } from "lucide-react";

export default function Section({ title, icon: Icon, children, locked }) {
  return (
    <div className={`rounded-2xl border p-4 space-y-3 ${locked ? "border-border bg-muted/20 opacity-60 pointer-events-none" : "border-border bg-card"}`}>
      <div className="flex items-center gap-2">
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
        <h3 className="font-semibold text-sm">{title}</h3>
        {locked && <Lock className="w-3.5 h-3.5 text-muted-foreground ml-auto" />}
      </div>
      {locked ? (
        <p className="text-xs text-muted-foreground">Registre presença para acessar.</p>
      ) : children}
    </div>
  );
}
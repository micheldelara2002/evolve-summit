import { cn } from "@/lib/utils";

const TONE_CLASSES = {
  primary: "bg-primary/10 text-primary",
  secondary: "bg-secondary/15 text-secondary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

/**
 * Cabeçalho padrão para páginas filhas da home (nível 2).
 * Sem botão voltar, título em text-2xl, ícone colorido à esquerda.
 */
export default function PageHeader({ icon: Icon, title, subtitle, tone = "primary", actions }) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3">
      <div className="flex items-center gap-3 min-w-0">
        {Icon && (
          <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0", TONE_CLASSES[tone] || TONE_CLASSES.primary)}>
            <Icon className="w-5 h-5" strokeWidth={1.75} />
          </div>
        )}
        <div className="min-w-0">
          <h1 className="text-2xl font-display font-bold leading-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground truncate mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
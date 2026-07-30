import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

const ACCENTS = {
  primary: { bg: "bg-primary/10", text: "text-primary" },
  secondary: { bg: "bg-secondary/10", text: "text-secondary" },
  success: { bg: "bg-success/10", text: "text-success" },
  warning: { bg: "bg-warning/10", text: "text-warning" },
  accent: { bg: "bg-accent/10", text: "text-accent" },
  destructive: { bg: "bg-destructive/10", text: "text-destructive" },
};

export default function BusinessKPICard({ icon: Icon, label, value, delta, loading, error, accent = "primary" }) {
  const colors = ACCENTS[accent] || ACCENTS.primary;
  return (
    <Card className="relative overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide leading-tight">{label}</p>
            {loading ? (
              <div className="h-9 w-24 bg-muted animate-pulse rounded mt-2" />
            ) : error ? (
              <p className="text-sm text-muted-foreground mt-2">Indisponível</p>
            ) : (
              <>
                <p className="text-3xl font-display font-bold mt-1.5 tabular-nums">{value}</p>
                {delta === null ? (
                  <p className="text-xs text-muted-foreground mt-1">Novo no período</p>
                ) : (
                  <div className={`flex items-center gap-1 text-xs mt-1.5 ${
                    delta > 0 ? "text-success" : delta < 0 ? "text-destructive" : "text-muted-foreground"
                  }`}>
                    {delta > 0 ? <TrendingUp className="w-3 h-3" /> : delta < 0 ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                    <span className="tabular-nums">{delta > 0 ? "+" : ""}{delta.toFixed(1)}%</span>
                    <span className="text-muted-foreground">vs anterior</span>
                  </div>
                )}
              </>
            )}
          </div>
          {Icon && (
            <div className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center ${colors.bg}`}>
              <Icon className={`w-5 h-5 ${colors.text}`} strokeWidth={1.75} />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

export default function BusinessKPICard({ icon: Icon, label, value, delta, loading, error }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {Icon && <Icon className="w-4 h-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-8 w-24 bg-muted animate-pulse rounded" />
        ) : error ? (
          <p className="text-sm text-muted-foreground">Dados indisponíveis no momento</p>
        ) : (
          <>
            <p className="text-2xl font-display font-bold">{value}</p>
            {delta === null ? (
              <p className="text-xs text-muted-foreground mt-1">Novo no período</p>
            ) : (
              <div className={`flex items-center gap-1 text-xs mt-1 ${
                delta > 0 ? "text-emerald-600" : delta < 0 ? "text-red-600" : "text-muted-foreground"
              }`}>
                {delta > 0 ? <TrendingUp className="w-3 h-3" /> : delta < 0 ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                <span>{delta > 0 ? "+" : ""}{delta.toFixed(1)}% vs período anterior</span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
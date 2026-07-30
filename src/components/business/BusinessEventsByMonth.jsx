import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ResponsiveContainer } from "recharts";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";

const MONTH_NAMES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

export default function BusinessEventsByMonth({ events }) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const [year, setYear] = useState(currentYear);

  // Available years from events (plus current year)
  const availableYears = useMemo(() => {
    const years = new Set([currentYear]);
    events.forEach((e) => {
      if (e.start_date) years.add(new Date(e.start_date).getFullYear());
    });
    return Array.from(years).sort((a, b) => b - a);
  }, [events, currentYear]);

  const data = useMemo(() => {
    const counts = new Array(12).fill(0);
    events.forEach((e) => {
      if (!e.start_date) return;
      const d = new Date(e.start_date);
      if (d.getFullYear() === year) {
        counts[d.getMonth()]++;
      }
    });
    return MONTH_NAMES.map((name, i) => ({ month: name, count: counts[i] }));
  }, [events, year]);

  const total = data.reduce((sum, d) => sum + d.count, 0);
  const maxMonth = data.reduce((max, d) => (d.count > max.count ? d : max), data[0]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <CalendarDays className="w-4 h-4 text-primary" /> Eventos por mês
        </CardTitle>
        {/* Year selector */}
        <div className="flex items-center gap-1">
          {availableYears.slice(0, 4).map((y) => (
            <Button
              key={y}
              size="sm"
              variant={y === year ? "default" : "ghost"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setYear(y)}
            >
              {y}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline gap-3 mb-4">
          <p className="text-2xl font-display font-bold tabular-nums">{total}</p>
          <p className="text-xs text-muted-foreground">eventos em {year}</p>
          {total > 0 && (
            <span className="text-xs text-muted-foreground ml-auto hidden sm:inline">
              Pico: {maxMonth.month} ({maxMonth.count})
            </span>
          )}
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data} margin={{ top: 0, right: 0, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ fill: "hsl(var(--muted))" }}
              contentStyle={{ borderRadius: "var(--radius)", border: "1px solid hsl(var(--border))", fontSize: "12px" }}
            />
            <Bar dataKey="count" name="Eventos" radius={[6, 6, 0, 0]} maxBarSize={48}>
              {data.map((entry, i) => (
                <Cell
                  key={i}
                  fill={entry.count === maxMonth.count && entry.count > 0 ? "hsl(var(--secondary))" : "hsl(var(--primary))"}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
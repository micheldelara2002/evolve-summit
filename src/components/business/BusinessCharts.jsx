import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveContainer, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { Users, Target, Calendar } from "lucide-react";

const CHART_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

function ChartCard({ title, icon: Icon, children, loading, error, empty }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Icon className="w-4 h-4 text-primary" /> {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-[260px] flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground text-center px-4">
            Não foi possível carregar este indicador. Tente novamente.
          </div>
        ) : empty ? (
          <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">
            Sem dados para o período selecionado.
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

export default function BusinessCharts({ participantsEvolution, leadsByPartner, eventsStatus, loading, error }) {
  const eventsEmpty = !eventsStatus?.length || eventsStatus.every((s) => s.value === 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ChartCard title="Evolução de participantes únicos" icon={Users} loading={loading} error={error} empty={!participantsEvolution?.length}>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={participantsEvolution} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorPart" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
                <stop offset="95%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={{ borderRadius: "var(--radius)", border: "1px solid hsl(var(--border))", fontSize: "12px" }} />
            <Area type="monotone" dataKey="count" stroke="hsl(var(--chart-1))" strokeWidth={2.5} fill="url(#colorPart)" name="Participantes únicos" />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Leads por parceiro" icon={Target} loading={loading} error={error} empty={!leadsByPartner?.length}>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={leadsByPartner} layout="vertical" margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={{ borderRadius: "var(--radius)", border: "1px solid hsl(var(--border))", fontSize: "12px" }} cursor={{ fill: "hsl(var(--muted))" }} />
            <Bar dataKey="leads" name="Leads" radius={[0, 6, 6, 0]} maxBarSize={28}>
              {leadsByPartner?.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Eventos ativos vs encerrados" icon={Calendar} loading={loading} error={error} empty={eventsEmpty}>
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={eventsStatus} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={45} paddingAngle={3} label={({ name, value }) => `${name}: ${value}`}>
              <Cell fill="hsl(var(--chart-1))" />
              <Cell fill="hsl(var(--chart-4))" />
            </Pie>
            <Tooltip contentStyle={{ borderRadius: "var(--radius)", border: "1px solid hsl(var(--border))", fontSize: "12px" }} />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
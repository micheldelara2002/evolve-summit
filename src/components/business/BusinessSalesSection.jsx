import { useQuery } from "@tanstack/react-query";
import { DollarSign, Ticket, Receipt, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import BusinessKPICard from "@/components/business/BusinessKPICard";
import { getSalesMetrics } from "@/lib/commerceApi";

export default function BusinessSalesSection({ period, customStart, customEnd, eventFilter }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["sales-metrics", period, customStart, customEnd, eventFilter],
    queryFn: () => getSalesMetrics({ period, customStart, customEnd, eventFilter }),
  });

  const kpis = data?.kpis || {};
  const revenueDaily = data?.revenueDaily || [];
  const topEvents = data?.topEvents || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <DollarSign className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-display font-bold">Vendas de Ingressos</h2>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <BusinessKPICard icon={DollarSign} label="Receita" value={kpis.revenue ? `R$ ${Number(kpis.revenue.value).toFixed(2)}` : "R$ 0"} delta={kpis.revenue?.delta} loading={isLoading} error={isError} accent="success" />
        <BusinessKPICard icon={Ticket} label="Ingressos vendidos" value={kpis.ticketsSold?.value ?? 0} delta={kpis.ticketsSold?.delta} loading={isLoading} error={isError} accent="primary" />
        <BusinessKPICard icon={Receipt} label="Ticket médio" value={kpis.avgTicket ? `R$ ${Number(kpis.avgTicket.value).toFixed(2)}` : "R$ 0"} delta={kpis.avgTicket?.delta} loading={isLoading} error={isError} accent="secondary" />
        <BusinessKPICard icon={TrendingUp} label="Pedidos pagos" value={kpis.ordersPaid?.value ?? 0} delta={kpis.ordersPaid?.delta} loading={isLoading} error={isError} accent="accent" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium"><DollarSign className="w-4 h-4 text-primary" /> Receita por dia</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-[260px] flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
            ) : revenueDaily.length === 0 ? (
              <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">Sem vendas no período.</div>
            ) : (
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={revenueDaily} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--chart-3))" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="hsl(var(--chart-3))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ borderRadius: "var(--radius)", border: "1px solid hsl(var(--border))", fontSize: "12px" }} formatter={(v) => `R$ ${Number(v).toFixed(2)}`} />
                  <Area type="monotone" dataKey="revenue" stroke="hsl(var(--chart-3))" strokeWidth={2.5} fill="url(#colorRev)" name="Receita" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium"><TrendingUp className="w-4 h-4 text-primary" /> Top eventos por receita</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-[260px] flex items-center justify-center"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
            ) : topEvents.length === 0 ? (
              <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">Sem dados.</div>
            ) : (
              <div className="space-y-2">
                {topEvents.map((e, i) => (
                  <div key={e.id} className="flex items-center gap-3">
                    <span className="text-xs font-mono text-muted-foreground w-5">{i + 1}.</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{e.name}</p>
                    </div>
                    <span className="text-sm font-bold tabular-nums">R$ {Number(e.revenue).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
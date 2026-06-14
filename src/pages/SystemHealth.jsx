import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Activity, RefreshCw, AlertTriangle, CheckCircle2, Clock, Zap, FileX, Bell } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMemo } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

// ── helpers ───────────────────────────────────────────────────────────────────
function cutoff(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function fmtPct(n) {
  if (n === null || n === undefined) return "—";
  return n.toFixed(2).replace(".", ",") + "%";
}

function p95(arr) {
  if (!arr || arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({ icon: IconComp, label, value, sub, color = "text-primary", pending = false, loading = false }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium uppercase tracking-wide">
        <IconComp className={`w-4 h-4 ${color}`} />
        {label}
      </div>
      {loading ? (
        <div className="h-8 w-24 bg-muted animate-pulse rounded-lg" />
      ) : pending ? (
        <p className="text-sm text-amber-600 font-medium">Pendente de mapeamento</p>
      ) : (
        <p className="text-2xl font-display font-bold">{value}</p>
      )}
      {sub && !loading && !pending && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ── Trend chart ───────────────────────────────────────────────────────────────
function TrendChart({ data, dataKey, label, color = "#4F46E5" }) {
  if (!data || data.length === 0) return (
    <div className="rounded-2xl border border-border bg-card p-5 flex items-center justify-center h-40 text-muted-foreground text-sm">
      Sem dados históricos
    </div>
  );
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">{label}</p>
      <ResponsiveContainer width="100%" height={100}>
        <AreaChart data={data} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id={`grad-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={{ fontSize: 11 }} />
          <Area type="monotone" dataKey={dataKey} stroke={color} fill={`url(#grad-${dataKey})`} strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── PERIOD OPTIONS ─────────────────────────────────────────────────────────────
const PERIODS = [
  { value: "1d", label: "Hoje", days: 1 },
  { value: "7d", label: "7 dias", days: 7 },
  { value: "30d", label: "30 dias", days: 30 },
];

export default function SystemHealth() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const period = searchParams.get("period") || "7d";
  const periodDays = PERIODS.find((p) => p.value === period)?.days ?? 7;

  const setPeriod = (v) => setSearchParams((p) => { p.set("period", v); return p; });

  // ── Data fetching ─────────────────────────────────────────────────────────
  const { data: imports = [], isLoading: loadingImports, refetch: refetchImports } = useQuery({
    queryKey: ["imports-health"],
    queryFn: () => base44.entities.Import.list("-created_date", 500),
  });

  const { data: checkins = [], isLoading: loadingCheckins } = useQuery({
    queryKey: ["checkins-health"],
    queryFn: () => base44.entities.Checkin.list("-created_date", 500),
  });

  const { data: auditLogs = [], isLoading: loadingAudit } = useQuery({
    queryKey: ["audit-health"],
    queryFn: () => base44.entities.AuditLog.list("-created_date", 500),
  });

  const isLoading = loadingImports || loadingCheckins || loadingAudit;

  // ── Computed KPIs ────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const now = new Date();
    const cut = cutoff(periodDays);
    const cut24h = cutoff(1);
    const cut7d = cutoff(7);

    // 1. Uptime mensal (%): não há fonte de dados de uptime real — pendente
    const uptime = null; // PENDENTE: sem tabela de disponibilidade/health-beats
    console.info("[SystemHealth] KPI 'uptime': sem fonte de dados (tabela de availability não existe).");

    // 2. Latência API p95: não há fonte de dados de latência de API — pendente
    const latenciaApi = null;
    console.info("[SystemHealth] KPI 'latência API p95': sem fonte de dados (sem tabela de request logs).");

    // 3. Latência check-in p95: calcula via created_date de checkins no período
    const checkinsInPeriod = checkins.filter((c) => new Date(c.created_date) >= cut);
    // Proxy: diferença entre updated_date e created_date (quando há revert, indica processamento)
    const checkinDeltas = checkinsInPeriod
      .filter((c) => c.updated_date && c.updated_date !== c.created_date)
      .map((c) => new Date(c.updated_date) - new Date(c.created_date));
    const latenciaCheckin = checkinDeltas.length >= 5 ? p95(checkinDeltas) : null;
    if (checkinDeltas.length < 5) console.info("[SystemHealth] KPI 'latência check-in p95': amostra insuficiente.");

    // 4. Taxa de erro API: não há fonte de dados — pendente
    const taxaErroApi = null;
    console.info("[SystemHealth] KPI 'taxa de erro API': sem fonte de dados (sem tabela de request logs).");

    // 5. Falhas de importação
    const falhas24h = imports.filter((i) => i.status === "failed" && new Date(i.created_date) >= cut24h).length;
    const falhas7d = imports.filter((i) => i.status === "failed" && new Date(i.created_date) >= cut7d).length;

    // 6. Alertas ativos: usa logs de erro/falha no período como proxy
    const alertasAtivos = imports.filter((i) => i.status === "failed" && new Date(i.created_date) >= cut).length;

    // Trend: importações com falha por dia (últimos 7d)
    const importTrend = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      const dateStr = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      const failed = imports.filter((imp) => {
        const dd = new Date(imp.created_date);
        return imp.status === "failed" && dd.toDateString() === d.toDateString();
      }).length;
      return { date: dateStr, falhas: failed };
    });

    // Trend: check-ins por dia
    const checkinTrend = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      const dateStr = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      const count = checkins.filter((c) => {
        const dd = new Date(c.created_date);
        return dd.toDateString() === d.toDateString();
      }).length;
      return { date: dateStr, checkins: count };
    });

    return { uptime, latenciaApi, latenciaCheckin, taxaErroApi, falhas24h, falhas7d, alertasAtivos, importTrend, checkinTrend };
  }, [imports, checkins, auditLogs, periodDays]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-emerald-600" />
            <h1 className="text-xl font-display font-bold">{t("home.systemHealth")}</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={setPeriod}>
            <SelectTrigger className="h-8 w-28 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="gap-1 h-8" onClick={() => refetchImports()}>
            <RefreshCw className="w-3.5 h-3.5" /> Atualizar
          </Button>
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <KpiCard
          icon={CheckCircle2}
          label="Uptime Mensal"
          value={kpis.uptime !== null ? fmtPct(kpis.uptime) : undefined}
          pending={kpis.uptime === null}
          loading={isLoading}
          color="text-emerald-600"
          sub="Disponibilidade no período"
        />
        <KpiCard
          icon={Zap}
          label="Latência API p95"
          value={kpis.latenciaApi !== null ? `${kpis.latenciaApi}ms` : undefined}
          pending={kpis.latenciaApi === null}
          loading={isLoading}
          color="text-sky-600"
          sub="Percentil 95 das requisições"
        />
        <KpiCard
          icon={Clock}
          label="Latência Check-in p95"
          value={kpis.latenciaCheckin !== null ? `${Math.round(kpis.latenciaCheckin)}ms` : undefined}
          pending={kpis.latenciaCheckin === null}
          loading={isLoading}
          color="text-violet-600"
          sub={kpis.latenciaCheckin !== null ? "Percentil 95 do processamento" : "Amostra insuficiente"}
        />
        <KpiCard
          icon={AlertTriangle}
          label="Taxa de Erro API"
          value={kpis.taxaErroApi !== null ? fmtPct(kpis.taxaErroApi) : undefined}
          pending={kpis.taxaErroApi === null}
          loading={isLoading}
          color="text-red-500"
          sub="4xx/5xx sobre total de requisições"
        />
        <KpiCard
          icon={FileX}
          label="Falhas de Importação"
          value={kpis.falhas24h !== undefined ? `${kpis.falhas24h} (24h) / ${kpis.falhas7d} (7d)` : undefined}
          pending={false}
          loading={isLoading}
          color="text-amber-600"
          sub="Importações com status 'failed'"
        />
        <KpiCard
          icon={Bell}
          label="Alertas Ativos"
          value={kpis.alertasAtivos !== undefined ? String(kpis.alertasAtivos) : undefined}
          pending={false}
          loading={isLoading}
          color={kpis.alertasAtivos > 0 ? "text-red-500" : "text-emerald-600"}
          sub="Importações com falha no período"
        />
      </div>

      {/* Trend charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TrendChart
          data={kpis.importTrend}
          dataKey="falhas"
          label="Falhas de Importação — últimos 7 dias"
          color="#F59E0B"
        />
        <TrendChart
          data={kpis.checkinTrend}
          dataKey="checkins"
          label="Check-ins — últimos 7 dias"
          color="#4F46E5"
        />
      </div>

      {/* Nota técnica */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
        <p className="font-semibold mb-1">Pendência de mapeamento</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>Uptime mensal: sem tabela de availability/health-beats.</li>
          <li>Latência API p95: sem tabela de request-logs.</li>
          <li>Taxa de erro API: sem tabela de request-logs.</li>
        </ul>
        <p className="mt-2">Para habilitar esses KPIs, criar tabelas de monitoramento e ingerir dados de infra/APM.</p>
      </div>
    </div>
  );
}
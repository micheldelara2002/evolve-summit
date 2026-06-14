import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { t } from "@/lib/i18n";
import { filterEventsByAccess, isAdmin } from "@/lib/access";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, Filter, ChevronDown, ChevronUp } from "lucide-react";
import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

const ACTIONS = ["create", "update", "soft_delete", "status_change", "role_change", "import", "checkin_revert", "export"];

const actionColors = {
  create: "bg-emerald-100 text-emerald-700",
  update: "bg-sky-100 text-sky-700",
  soft_delete: "bg-red-100 text-red-700",
  status_change: "bg-amber-100 text-amber-700",
  role_change: "bg-purple-100 text-purple-700",
  import: "bg-indigo-100 text-indigo-700",
  checkin_revert: "bg-orange-100 text-orange-700",
  export: "bg-gray-100 text-gray-700",
};

export default function AuditLog() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [eventFilter, setEventFilter] = useState("all");
  const [periodFilter, setPeriodFilter] = useState("all");
  const [sortDir, setSortDir] = useState("desc");
  const [showFilters, setShowFilters] = useState(false);

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => base44.entities.AuditLog.list("-created_date", 200),
  });

  const { data: events = [] } = useQuery({
    queryKey: ["events"],
    queryFn: () => base44.entities.Event.filter({ is_deleted: false }),
  });

  const scopedEvents = filterEventsByAccess(events, user);
  const scopedEventIds = new Set(scopedEvents.map((e) => e.id));
  const eventName = (id) => scopedEvents.find((e) => e.id === id)?.name || id || "—";

  const filtered = useMemo(() => {
    let result = [...logs];
    if (!isAdmin(user)) {
      result = result.filter((l) => !l.event_id || scopedEventIds.has(l.event_id));
    }
    if (actionFilter !== "all") result = result.filter((l) => l.action === actionFilter);
    if (eventFilter !== "all") result = result.filter((l) => l.event_id === eventFilter);
    if (periodFilter !== "all") {
      const now = new Date();
      const map = { "24h": 1, "7d": 7, "30d": 30 };
      const cutoff = new Date(now - map[periodFilter] * 24 * 60 * 60 * 1000);
      result = result.filter((l) => new Date(l.created_date) > cutoff);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) =>
        (l.user_name || "").toLowerCase().includes(q) ||
        (l.entity_type || "").toLowerCase().includes(q) ||
        (l.details || "").toLowerCase().includes(q)
      );
    }
    result.sort((a, b) => {
      const da = new Date(a.created_date), db = new Date(b.created_date);
      return sortDir === "desc" ? db - da : da - db;
    });
    return result;
  }, [logs, actionFilter, eventFilter, periodFilter, search, sortDir, user]);

  const fmtDate = (d) => new Date(d).toLocaleDateString("pt-BR");
  const fmtTime = (d) => new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-display font-bold">{t("audit.title")}</h1>
        <Button variant="outline" size="sm" className="gap-1" onClick={() => setShowFilters(!showFilters)}>
          <Filter className="w-4 h-4" /> {t("audit.filters")}
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder={t("events.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <AnimatePresence>
        {showFilters && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pb-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t("audit.actionFilter")}</label>
                <Select value={actionFilter} onValueChange={setActionFilter}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("audit.all")}</SelectItem>
                    {ACTIONS.map((a) => <SelectItem key={a} value={a}>{t(`actions.${a}`)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t("audit.eventFilter")}</label>
                <Select value={eventFilter} onValueChange={setEventFilter}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("audit.all")}</SelectItem>
                    {scopedEvents.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t("audit.period")}</label>
                <Select value={periodFilter} onValueChange={setPeriodFilter}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("audit.all")}</SelectItem>
                    <SelectItem value="24h">Últimas 24h</SelectItem>
                    <SelectItem value="7d">Últimos 7 dias</SelectItem>
                    <SelectItem value="30d">Últimos 30 dias</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex justify-between items-center">
        <p className="text-xs text-muted-foreground">
          {t("common.showing")} {filtered.length} {t("common.results")}
        </p>
        <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setSortDir(sortDir === "desc" ? "asc" : "desc")}>
          {sortDir === "desc" ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
          {t("audit.date")}
        </Button>
      </div>

      {isLoading && (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Table */}
      {!isLoading && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/60 text-left">
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap">{t("audit.date")}</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">{t("audit.user")}</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden sm:table-cell">{t("audit.event")}</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">{t("audit.action")}</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden md:table-cell">{t("audit.entity")}</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden lg:table-cell">{t("audit.details")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log, idx) => (
                  <tr
                    key={log.id}
                    className={`border-t border-border ${idx % 2 === 0 ? "bg-card" : "bg-muted/20"} hover:bg-muted/40 transition-colors`}
                  >
                    <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      <span>{fmtDate(log.created_date)}</span>
                      <span className="block text-muted-foreground/70">{fmtTime(log.created_date)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs font-medium max-w-[120px] truncate">{log.user_name || "Sistema"}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground hidden sm:table-cell max-w-[140px] truncate">{eventName(log.event_id)}</td>
                    <td className="px-3 py-2.5">
                      <Badge variant="secondary" className={`text-xs whitespace-nowrap ${actionColors[log.action] || ""}`}>
                        {t(`actions.${log.action}`) || log.action}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell">{log.entity_type || "—"}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground hidden lg:table-cell max-w-[220px] truncate font-mono">
                      {log.details ? log.details.slice(0, 80) + (log.details.length > 80 ? "…" : "") : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <p className="text-center text-muted-foreground py-8 text-sm">{t("audit.noLogs")}</p>
          )}
        </div>
      )}
    </div>
  );
}
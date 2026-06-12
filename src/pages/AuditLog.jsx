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
  create: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  update: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
  soft_delete: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  status_change: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  role_change: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  import: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
  checkin_revert: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  export: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400",
};

export default function AuditLog() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [eventFilter, setEventFilter] = useState("all");
  const [periodFilter, setPeriodFilter] = useState("all");
  const [sortDir, setSortDir] = useState("desc");
  const [showFilters, setShowFilters] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

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

  const filtered = useMemo(() => {
    let result = logs;

    // Scope by access
    if (!isAdmin(user)) {
      result = result.filter((l) => !l.event_id || scopedEventIds.has(l.event_id));
    }

    // Action filter
    if (actionFilter !== "all") {
      result = result.filter((l) => l.action === actionFilter);
    }

    // Event filter
    if (eventFilter !== "all") {
      result = result.filter((l) => l.event_id === eventFilter);
    }

    // Period filter
    if (periodFilter !== "all") {
      const now = new Date();
      let cutoff;
      switch (periodFilter) {
        case "24h": cutoff = new Date(now - 24 * 60 * 60 * 1000); break;
        case "7d": cutoff = new Date(now - 7 * 24 * 60 * 60 * 1000); break;
        case "30d": cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000); break;
        default: cutoff = null;
      }
      if (cutoff) result = result.filter((l) => new Date(l.created_date) > cutoff);
    }

    // Search
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) =>
        (l.user_name || "").toLowerCase().includes(q) ||
        (l.entity_type || "").toLowerCase().includes(q) ||
        (l.details || "").toLowerCase().includes(q)
      );
    }

    // Sort
    result.sort((a, b) => {
      const da = new Date(a.created_date);
      const db = new Date(b.created_date);
      return sortDir === "desc" ? db - da : da - db;
    });

    return result;
  }, [logs, actionFilter, eventFilter, periodFilter, search, sortDir, user]);

  const eventName = (id) => scopedEvents.find((e) => e.id === id)?.name || "—";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-display font-bold">{t("audit.title")}</h1>
        <Button variant="outline" size="sm" className="gap-1" onClick={() => setShowFilters(!showFilters)}>
          <Filter className="w-4 h-4" /> {t("audit.filters")}
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder={t("events.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Filters */}
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
                    {ACTIONS.map((a) => (
                      <SelectItem key={a} value={a}>{t(`actions.${a}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">{t("audit.eventFilter")}</label>
                <Select value={eventFilter} onValueChange={setEventFilter}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("audit.all")}</SelectItem>
                    {scopedEvents.map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                    ))}
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

      {/* Sort toggle */}
      <div className="flex justify-between items-center">
        <p className="text-xs text-muted-foreground">
          {t("common.showing")} {filtered.length} {t("common.results")}
        </p>
        <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setSortDir(sortDir === "desc" ? "asc" : "desc")}>
          {sortDir === "desc" ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
          {t("audit.date")}
        </Button>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Log list */}
      <div className="space-y-2">
        <AnimatePresence>
          {filtered.map((log) => (
            <motion.div
              key={log.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="bg-card rounded-xl border border-border p-3 cursor-pointer hover:shadow-sm transition-shadow"
              onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className={`text-xs ${actionColors[log.action] || ""}`}>
                      {t(`actions.${log.action}`) || log.action}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{log.entity_type}</span>
                  </div>
                  <p className="text-sm mt-1">{log.user_name || "Sistema"}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-muted-foreground">
                    {new Date(log.created_date).toLocaleDateString("pt-BR")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(log.created_date).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </div>
              {log.event_id && (
                <p className="text-xs text-muted-foreground mt-1">Evento: {eventName(log.event_id)}</p>
              )}
              {expandedId === log.id && log.details && (
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: "auto" }}
                  className="mt-2 p-2 rounded bg-muted/50 overflow-hidden"
                >
                  <p className="text-xs font-mono break-all">{log.details}</p>
                </motion.div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {!isLoading && filtered.length === 0 && (
          <p className="text-center text-muted-foreground py-8">{t("audit.noLogs")}</p>
        )}
      </div>
    </div>
  );
}
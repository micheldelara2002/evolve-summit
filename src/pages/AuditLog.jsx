import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { t } from "@/lib/i18n";
import { filterEventsByAccess, isAdmin } from "@/lib/access";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, Filter, ChevronDown, ChevronUp, GripVertical, RotateCcw, Shield } from "lucide-react";
import { useState, useMemo, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import PageHeader from "@/components/layout/PageHeader";

const ACTIONS = ["create", "update", "soft_delete", "status_change", "role_change", "import", "export"];

const actionColors = {
  create: "bg-emerald-100 text-emerald-700",
  update: "bg-sky-100 text-sky-700",
  soft_delete: "bg-red-100 text-red-700",
  status_change: "bg-amber-100 text-amber-700",
  role_change: "bg-purple-100 text-purple-700",
  import: "bg-indigo-100 text-indigo-700",
  export: "bg-gray-100 text-gray-700",
};

function parseDetail(details, field) {
  if (!details) return "—";
  try {
    const obj = typeof details === "string" ? JSON.parse(details) : details;
    return obj[field] !== undefined ? String(obj[field]) : "—";
  } catch {
    return "—";
  }
}

// ── Column definitions ────────────────────────────────────────────────────────
const DEFAULT_COLUMNS = [
  { id: "date",       label: "Data/Hora",      always: true },
  { id: "user",       label: "Usuário",        always: true },
  { id: "event",      label: "Evento" },
  { id: "action",    label: "Ação",            always: true },
  { id: "entity",    label: "Entidade" },
  { id: "ip",        label: "IP" },
  { id: "field",     label: "Campo" },
  { id: "old_value", label: "Valor anterior" },
  { id: "new_value", label: "Valor novo" },
];

const STORAGE_KEY = "audit_col_order_v1";

function loadColOrder() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    // Validate all default IDs are present
    const defaultIds = DEFAULT_COLUMNS.map((c) => c.id);
    if (saved.length !== defaultIds.length || !defaultIds.every((id) => saved.includes(id))) return null;
    return saved;
  } catch {
    return null;
  }
}

function saveColOrder(order) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(order)); } catch {}
}

// ── Cell renderer ─────────────────────────────────────────────────────────────
function renderCell(colId, log, eventName) {
  const fmtDate = (d) => new Date(d).toLocaleDateString("pt-BR");
  const fmtTime = (d) => new Date(d).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  switch (colId) {
    case "date":
      return (
        <td key="date" className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
          <span>{fmtDate(log.created_date)}</span>
          <span className="block text-muted-foreground/70">{fmtTime(log.created_date)}</span>
        </td>
      );
    case "user":
      return <td key="user" className="px-3 py-2.5 text-xs font-medium max-w-[120px] truncate">{log.user_name || "Sistema"}</td>;
    case "event":
      return <td key="event" className="px-3 py-2.5 text-xs text-muted-foreground max-w-[140px] truncate">{eventName(log.event_id)}</td>;
    case "action":
      return (
        <td key="action" className="px-3 py-2.5">
          <Badge variant="secondary" className={`text-xs whitespace-nowrap ${actionColors[log.action] || ""}`}>
            {t(`actions.${log.action}`) || log.action}
          </Badge>
        </td>
      );
    case "entity":
      return <td key="entity" className="px-3 py-2.5 text-xs text-muted-foreground">{log.entity_type || "—"}</td>;
    case "ip":
      return <td key="ip" className="px-3 py-2.5 text-xs text-muted-foreground font-mono">{log.ip_address || "—"}</td>;
    case "field":
      return <td key="field" className="px-3 py-2.5 text-xs text-muted-foreground max-w-[120px] truncate">{parseDetail(log.details, "field")}</td>;
    case "old_value":
      return <td key="old_value" className="px-3 py-2.5 text-xs text-muted-foreground max-w-[120px] truncate">{parseDetail(log.details, "old_value")}</td>;
    case "new_value":
      return <td key="new_value" className="px-3 py-2.5 text-xs text-muted-foreground max-w-[120px] truncate">{parseDetail(log.details, "new_value")}</td>;
    default:
      return <td key={colId} className="px-3 py-2.5" />;
  }
}

export default function AuditLog() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("all");
  const [eventFilter, setEventFilter] = useState("all");
  const [periodFilter, setPeriodFilter] = useState("all");
  const [sortDir, setSortDir] = useState("desc");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  // Column order — persisted
  const [colOrder, setColOrder] = useState(() => loadColOrder() || DEFAULT_COLUMNS.map((c) => c.id));

  const orderedCols = useMemo(() => colOrder.map((id) => DEFAULT_COLUMNS.find((c) => c.id === id)).filter(Boolean), [colOrder]);

  const handleDragEnd = useCallback((result) => {
    if (!result.destination) return;
    const newOrder = [...colOrder];
    const [moved] = newOrder.splice(result.source.index, 1);
    newOrder.splice(result.destination.index, 0, moved);
    setColOrder(newOrder);
    saveColOrder(newOrder);
  }, [colOrder]);

  const resetColOrder = () => {
    const def = DEFAULT_COLUMNS.map((c) => c.id);
    setColOrder(def);
    saveColOrder(def);
  };

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

  // Reset page when filters change (safe — outside render)
  useEffect(() => { setPage(1); }, [actionFilter, eventFilter, periodFilter, search, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Shield}
        title={t("audit.title")}
        tone="warning"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1" onClick={resetColOrder}>
              <RotateCcw className="w-3.5 h-3.5" /> Padrão
            </Button>
            <Button variant="outline" size="sm" className="gap-1" onClick={() => setShowFilters(!showFilters)}>
              <Filter className="w-4 h-4" /> {t("audit.filters")}
            </Button>
          </div>
        }
      />

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
          {filtered.length} {t("common.results")} — página {page} de {totalPages}
          <span className="ml-2 text-muted-foreground/60">— arraste cabeçalhos para reordenar</span>
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

      {!isLoading && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <DragDropContext onDragEnd={handleDragEnd}>
                  <Droppable droppableId="audit-cols" direction="horizontal">
                    {(provided) => (
                      <tr
                        className="bg-muted/60 text-left"
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                      >
                        {orderedCols.map((col, idx) => (
                          <Draggable key={col.id} draggableId={col.id} index={idx}>
                            {(drag, snapshot) => (
                              <th
                                ref={drag.innerRef}
                                {...drag.draggableProps}
                                className={`px-3 py-2.5 text-xs font-semibold text-muted-foreground whitespace-nowrap select-none ${snapshot.isDragging ? "bg-primary/10" : ""}`}
                                style={{ ...drag.draggableProps.style, display: "table-cell" }}
                              >
                                <div className="flex items-center gap-1">
                                  <span {...drag.dragHandleProps} className="cursor-grab opacity-40 hover:opacity-80">
                                    <GripVertical className="w-3 h-3" />
                                  </span>
                                  {col.label}
                                </div>
                              </th>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                      </tr>
                    )}
                  </Droppable>
                </DragDropContext>
              </thead>
              <tbody>
                {paginated.map((log, idx) => (
                  <tr
                    key={log.id}
                    className={`border-t border-border ${idx % 2 === 0 ? "bg-card" : "bg-muted/20"} hover:bg-muted/40 transition-colors`}
                  >
                    {orderedCols.map((col) => renderCell(col.id, log, eventName))}
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

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
            Anterior
          </Button>
          <div className="flex gap-1">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <Button
                key={p}
                variant={p === page ? "default" : "outline"}
                size="sm"
                className="w-8 h-8 p-0"
                onClick={() => setPage(p)}
              >
                {p}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(page + 1)}>
            Próxima
          </Button>
        </div>
      )}
    </div>
  );
}
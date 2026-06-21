/**
 * Programação do evento para o participante.
 * - Filtros: trilha, sala, tipo
 * - Modos: lista / grid
 * - Navegação por data
 * - Preferências persistidas em localStorage por user+event
 */
import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Calendar, Clock, MapPin, Mic, LayoutList, LayoutGrid, ChevronLeft, ChevronRight, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/AuthContext";

const SESSION_TYPE_LABELS = {
  aula: "Aula", debate: "Debate", demonstracao: "Demonstração",
  keynote: "Keynote", mesa_redonda: "Mesa redonda", palestra: "Palestra",
  painel: "Painel", simulacao: "Simulação", workshop: "Workshop",
};

function formatTime(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatDateLabel(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("pt-BR", {
    weekday: "long", day: "numeric", month: "long",
  });
}

// ── Session card (lista) ─────────────────────────────────────────────────────
function SessionListItem({ session, track, room }) {
  return (
    <div
      className="bg-card rounded-xl border border-border p-4 hover:shadow-sm transition-shadow"
      style={track?.color ? { borderLeftColor: track.color, borderLeftWidth: 3 } : {}}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm">{session.title}</p>
          {session.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{session.description}</p>
          )}
          <div className="flex flex-wrap items-center gap-3 mt-2">
            {session.start_time && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="w-3 h-3" />
                {formatTime(session.start_time)}
                {session.end_time && ` – ${formatTime(session.end_time)}`}
              </span>
            )}
            {room && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="w-3 h-3" /> {room.name}
              </span>
            )}
            {session.speaker_name && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Mic className="w-3 h-3" /> {session.speaker_name}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          {session.session_type && (
            <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
              {SESSION_TYPE_LABELS[session.session_type] || session.session_type}
            </span>
          )}
          {track && (
            <span
              className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
              style={{ backgroundColor: track.color || "#6366f1" }}
            >
              {track.name}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Session card (grid) ──────────────────────────────────────────────────────
function SessionGridCard({ session, track, room }) {
  return (
    <div
      className="bg-card rounded-2xl border border-border p-4 flex flex-col gap-2 hover:shadow-md transition-shadow"
      style={track?.color ? { borderTopColor: track.color, borderTopWidth: 3 } : {}}
    >
      {track && (
        <span
          className="inline-flex self-start px-2 py-0.5 rounded-full text-[10px] font-medium text-white mb-0.5"
          style={{ backgroundColor: track.color || "#6366f1" }}
        >
          {track.name}
        </span>
      )}
      <p className="font-semibold text-sm line-clamp-2 flex-1">{session.title}</p>
      {session.start_time && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="w-3 h-3" />
          {formatTime(session.start_time)}
          {session.end_time && ` – ${formatTime(session.end_time)}`}
        </span>
      )}
      {room && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="w-3 h-3" /> {room.name}
        </span>
      )}
      {session.session_type && (
        <span className="inline-flex self-start px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
          {SESSION_TYPE_LABELS[session.session_type] || session.session_type}
        </span>
      )}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function ProgramacaoView({ eventId }) {
  const { user } = useAuth();
  const PREF_KEY = `prog_pref_${user?.id}_${eventId}`;

  // Load persisted prefs
  const loadPrefs = () => {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch { return {}; }
  };

  const [viewMode, setViewMode] = useState(() => loadPrefs().viewMode || "lista");
  const [showFilters, setShowFilters] = useState(false);
  const [pendingFilters, setPendingFilters] = useState(() => loadPrefs().filters || { track_id: "", room_id: "", session_type: "" });
  const [activeFilters, setActiveFilters] = useState(() => loadPrefs().filters || { track_id: "", room_id: "", session_type: "" });
  const [selectedDateIdx, setSelectedDateIdx] = useState(0);

  // Persist prefs
  useEffect(() => {
    localStorage.setItem(PREF_KEY, JSON.stringify({ viewMode, filters: activeFilters }));
  }, [viewMode, activeFilters]);

  const { data: sessions = [], isLoading } = useQuery({
    queryKey: ["sessions", eventId],
    queryFn: () => base44.entities.Session.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: tracks = [] } = useQuery({
    queryKey: ["tracks", eventId],
    queryFn: () => base44.entities.Track.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: rooms = [] } = useQuery({
    queryKey: ["rooms", eventId],
    queryFn: () => base44.entities.Room.filter({ event_id: eventId, is_deleted: false }),
  });

  const trackMap = useMemo(() => Object.fromEntries(tracks.map((t) => [t.id, t])), [tracks]);
  const roomMap = useMemo(() => Object.fromEntries(rooms.map((r) => [r.id, r])), [rooms]);

  // Sorted sessions
  const sortedSessions = useMemo(
    () => sessions.slice().sort((a, b) => new Date(a.start_time) - new Date(b.start_time)),
    [sessions]
  );

  // Unique dates
  const dates = useMemo(() => {
    const set = new Set();
    sortedSessions.forEach((s) => {
      if (s.start_time) set.add(new Date(s.start_time).toISOString().slice(0, 10));
    });
    return Array.from(set).sort();
  }, [sortedSessions]);

  // Clamp selectedDateIdx
  const safeDateIdx = Math.min(selectedDateIdx, Math.max(0, dates.length - 1));

  // Apply filters + selected date
  const filteredSessions = useMemo(() => {
    return sortedSessions.filter((s) => {
      if (dates.length > 0) {
        const sDate = s.start_time ? new Date(s.start_time).toISOString().slice(0, 10) : null;
        if (sDate !== dates[safeDateIdx]) return false;
      }
      if (activeFilters.track_id && s.track_id !== activeFilters.track_id) return false;
      if (activeFilters.room_id && s.room_id !== activeFilters.room_id) return false;
      if (activeFilters.session_type && s.session_type !== activeFilters.session_type) return false;
      return true;
    });
  }, [sortedSessions, dates, safeDateIdx, activeFilters]);

  const hasActiveFilters = Object.values(activeFilters).some(Boolean);

  const applyFilters = () => {
    setActiveFilters({ ...pendingFilters });
    setShowFilters(false);
  };

  const clearFilters = () => {
    const empty = { track_id: "", room_id: "", session_type: "" };
    setPendingFilters(empty);
    setActiveFilters(empty);
    setShowFilters(false);
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Calendar className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p>Nenhuma sessão cadastrada ainda.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {/* Date navigation */}
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={safeDateIdx === 0}
            onClick={() => setSelectedDateIdx((i) => Math.max(0, i - 1))}
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="min-w-[140px] text-center">
            <p className="text-sm font-medium capitalize">
              {dates[safeDateIdx] ? formatDateLabel(dates[safeDateIdx]) : "—"}
            </p>
            {dates.length > 1 && (
              <p className="text-xs text-muted-foreground">{safeDateIdx + 1} / {dates.length}</p>
            )}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={safeDateIdx >= dates.length - 1}
            onClick={() => setSelectedDateIdx((i) => Math.min(dates.length - 1, i + 1))}
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-2">
          <Button
            variant={showFilters || hasActiveFilters ? "default" : "outline"}
            size="sm"
            className="gap-1.5"
            onClick={() => setShowFilters((v) => !v)}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Filtros
            {hasActiveFilters && (
              <span className="ml-0.5 w-4 h-4 rounded-full bg-white/30 text-xs flex items-center justify-center">
                {Object.values(activeFilters).filter(Boolean).length}
              </span>
            )}
          </Button>

          {/* View mode toggle */}
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button
              onClick={() => setViewMode("lista")}
              className={`px-2.5 py-1.5 transition-colors ${viewMode === "lista" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
            >
              <LayoutList className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode("grid")}
              className={`px-2.5 py-1.5 border-l border-border transition-colors ${viewMode === "grid" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Filters panel */}
      {showFilters && (
        <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Trilha */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Trilha</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={pendingFilters.track_id}
                onChange={(e) => setPendingFilters((f) => ({ ...f, track_id: e.target.value }))}
              >
                <option value="">Todas</option>
                {tracks.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>

            {/* Sala */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Sala</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={pendingFilters.room_id}
                onChange={(e) => setPendingFilters((f) => ({ ...f, room_id: e.target.value }))}
              >
                <option value="">Todas</option>
                {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>

            {/* Tipo */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Tipo</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={pendingFilters.session_type}
                onChange={(e) => setPendingFilters((f) => ({ ...f, session_type: e.target.value }))}
              >
                <option value="">Todos</option>
                {Object.entries(SESSION_TYPE_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={clearFilters}>
              <X className="w-3.5 h-3.5" /> Limpar
            </Button>
            <Button size="sm" onClick={applyFilters}>Salvar</Button>
          </div>
        </div>
      )}

      {/* Sessions */}
      {filteredSessions.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground">
          <Calendar className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Nenhuma sessão encontrada para os filtros selecionados.</p>
          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-primary text-sm mt-2 hover:underline">
              Limpar filtros
            </button>
          )}
        </div>
      ) : viewMode === "lista" ? (
        <div className="space-y-3">
          {filteredSessions.map((s) => (
            <SessionListItem key={s.id} session={s} track={trackMap[s.track_id]} room={roomMap[s.room_id]} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredSessions.map((s) => (
            <SessionGridCard key={s.id} session={s} track={trackMap[s.track_id]} room={roomMap[s.room_id]} />
          ))}
        </div>
      )}
    </div>
  );
}
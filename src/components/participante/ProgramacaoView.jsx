/**
 * Programação do evento para o participante.
 * - Favoritar sessões (toggle por participante)
 * - Filtros: trilha, sala, tipo, somente favoritos
 * - Modos: lista / grid calendário (todos os dias × horários)
 * - Navegação por data (modo lista)
 * - Preferências persistidas em localStorage por user+event
 * - Clique na sessão → SessionDetail
 */
import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import {
  Calendar, Clock, MapPin, Mic, LayoutList, LayoutGrid,
  ChevronLeft, ChevronRight, SlidersHorizontal, X, Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/AuthContext";
import SessionDetail from "@/components/participante/SessionDetail";

const SESSION_TYPE_LABELS = {
  aula: "Aula", debate: "Debate", demonstracao: "Demonstração",
  keynote: "Keynote", mesa_redonda: "Mesa redonda", palestra: "Palestra",
  painel: "Painel", simulacao: "Simulação", workshop: "Workshop",
};

function isValidHex(color) {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

function formatTime(dt) {
  if (!dt) return "";
  return new Date(dt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatDateLabel(dateStr) {
  if (!dateStr) return "";
  return new Date(dateStr + "T00:00:00").toLocaleDateString("pt-BR", {
    weekday: "short", day: "numeric", month: "short",
  });
}

// ── Favorite button ───────────────────────────────────────────────────────────
function FavoriteBtn({ isFav, onToggle, size = "sm" }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={`shrink-0 inline-flex items-center justify-center min-h-[44px] min-w-[44px] transition-colors ${
        size === "sm" ? "rounded-lg" : "rounded-xl"
      } ${isFav ? "text-amber-500 hover:text-amber-600" : "text-muted-foreground/40 hover:text-amber-400"}`}
      title={isFav ? "Remover favorito" : "Favoritar"}
      aria-label={isFav ? "Remover favorito" : "Favoritar sessão"}
    >
      <Star className={`${size === "sm" ? "w-4 h-4" : "w-5 h-5"} ${isFav ? "fill-current" : ""}`} />
    </button>
  );
}

// ── Session card lista ────────────────────────────────────────────────────────
function SessionListItem({ session, track, room, isFav, onToggleFav, onClick }) {
  return (
    <div
      onClick={onClick}
      className="bg-card rounded-xl border border-border p-4 hover:shadow-sm transition-shadow cursor-pointer"
      style={isValidHex(track?.color) ? { borderLeftColor: track.color, borderLeftWidth: 3 } : {}}
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
                {formatTime(session.start_time)}{session.end_time && ` – ${formatTime(session.end_time)}`}
              </span>
            )}
            {room && <span className="flex items-center gap-1 text-xs text-muted-foreground"><MapPin className="w-3 h-3" />{room.name}</span>}
            {session.speaker_name && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Mic className="w-3 h-3" />{session.speaker_name}</span>}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          <FavoriteBtn isFav={isFav} onToggle={onToggleFav} />
          {session.session_type && (
            <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
              {SESSION_TYPE_LABELS[session.session_type] || session.session_type}
            </span>
          )}
          {track && (
            <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium text-white"
              style={{ backgroundColor: isValidHex(track.color) ? track.color : "#6366f1" }}>
              {track.name}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Session card grid ─────────────────────────────────────────────────────────
function SessionGridCard({ session, track, room, isFav, onToggleFav, onClick, compact = false }) {
  return (
    <div
      onClick={onClick}
      className={`bg-card rounded-xl border border-border flex flex-col gap-1.5 hover:shadow-md transition-shadow cursor-pointer overflow-hidden ${compact ? "p-2 text-[11px]" : "p-3"}`}
      style={isValidHex(track?.color) ? { borderTopColor: track.color, borderTopWidth: 3 } : {}}
    >
      <div className="flex items-start justify-between gap-1">
        <p className={`font-semibold leading-tight line-clamp-2 flex-1 ${compact ? "text-[11px]" : "text-sm"}`}>{session.title}</p>
        <FavoriteBtn isFav={isFav} onToggle={onToggleFav} size="sm" />
      </div>
      {session.start_time && (
        <span className="flex items-center gap-1 text-muted-foreground" style={{ fontSize: compact ? 10 : 11 }}>
          <Clock className="w-2.5 h-2.5 shrink-0" />
          {formatTime(session.start_time)}{session.end_time && ` – ${formatTime(session.end_time)}`}
        </span>
      )}
      {room && !compact && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground"><MapPin className="w-3 h-3" />{room.name}</span>
      )}
      {track && !compact && (
        <span className="inline-flex self-start px-1.5 py-0.5 rounded-full text-[10px] font-medium text-white"
          style={{ backgroundColor: isValidHex(track.color) ? track.color : "#6366f1" }}>
          {track.name}
        </span>
      )}
    </div>
  );
}

// ── Calendar grid (todos os dias × horários) ──────────────────────────────────
function CalendarGrid({ sessions, trackMap, roomMap, dates, favSet, onToggleFav, onOpen }) {
  // Build hour slots from earliest start to latest end
  const allTimes = sessions.flatMap((s) => [s.start_time, s.end_time].filter(Boolean)).map((t) => new Date(t));
  if (allTimes.length === 0) return null;

  const minHour = Math.min(...allTimes.map((t) => t.getHours()));
  const maxHour = Math.max(...allTimes.map((t) => t.getHours() + 1));
  const hours = Array.from({ length: maxHour - minHour }, (_, i) => minHour + i);

  // Index sessions by date+hour
  const index = {};
  sessions.forEach((s) => {
    if (!s.start_time) return;
    const dt = new Date(s.start_time);
    const dateKey = dt.toISOString().slice(0, 10);
    const hour = dt.getHours();
    const key = `${dateKey}:${hour}`;
    if (!index[key]) index[key] = [];
    index[key].push(s);
  });

  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <div className="min-w-[600px]">
        {/* Header row */}
        <div className="grid gap-px bg-border" style={{ gridTemplateColumns: `60px repeat(${dates.length}, 1fr)` }}>
          <div className="bg-background p-2" />
          {dates.map((d) => (
            <div key={d} className="bg-muted/50 p-2 text-center">
              <p className="text-xs font-semibold capitalize">{formatDateLabel(d)}</p>
            </div>
          ))}
        </div>

        {/* Hour rows */}
        {hours.map((hour) => (
          <div key={hour} className="grid gap-px bg-border" style={{ gridTemplateColumns: `60px repeat(${dates.length}, 1fr)` }}>
            {/* Time label */}
            <div className="bg-background p-2 flex items-start justify-end">
              <span className="text-[11px] text-muted-foreground">{String(hour).padStart(2, "0")}:00</span>
            </div>
            {/* Cells per day */}
            {dates.map((d) => {
              const cell = index[`${d}:${hour}`] || [];
              return (
                <div key={d} className="bg-background min-h-[56px] p-1 flex flex-col gap-1">
                  {cell.map((s) => (
                    <SessionGridCard
                      key={s.id}
                      session={s}
                      track={trackMap[s.track_id]}
                      room={roomMap[s.room_id]}
                      isFav={favSet.has(s.id)}
                      onToggleFav={() => onToggleFav(s.id)}
                      onClick={() => onOpen(s)}
                      compact
                    />
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function ProgramacaoView({ eventId, participant, isReadOnly = false }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const PREF_KEY = `prog_pref_${user?.id}_${eventId}`;

  const loadPrefs = () => {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch { return {}; }
  };

  const [viewMode, setViewMode] = useState(() => loadPrefs().viewMode || "lista");
  const [showFilters, setShowFilters] = useState(false);
  const [pendingFilters, setPendingFilters] = useState(() => loadPrefs().filters || { track_id: "", room_id: "", session_type: "", only_favs: false });
  const [activeFilters, setActiveFilters] = useState(() => loadPrefs().filters || { track_id: "", room_id: "", session_type: "", only_favs: false });
  const [selectedDateIdx, setSelectedDateIdx] = useState(0);
  const [openSession, setOpenSession] = useState(null);

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

  // Favorites
  const { data: favorites = [] } = useQuery({
    queryKey: ["session-favorites", eventId, participant?.id],
    queryFn: () => base44.entities.SessionFavorite.filter({ event_id: eventId, participant_id: participant?.id }),
    enabled: !!participant?.id,
  });

  const favSet = useMemo(() => new Set(favorites.map((f) => f.session_id)), [favorites]);

  const toggleFavMut = useMutation({
    mutationFn: async (sessionId) => {
      const existing = favorites.find((f) => f.session_id === sessionId);
      if (existing) {
        await base44.entities.SessionFavorite.delete(existing.id);
      } else {
        await base44.entities.SessionFavorite.create({
          event_id: eventId,
          session_id: sessionId,
          participant_id: participant?.id,
          person_id: participant?.person_id,
        });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session-favorites", eventId, participant?.id] }),
  });

  const trackMap = useMemo(() => Object.fromEntries(tracks.map((t) => [t.id, t])), [tracks]);
  const roomMap = useMemo(() => Object.fromEntries(rooms.map((r) => [r.id, r])), [rooms]);

  const sortedSessions = useMemo(
    () => sessions.slice().sort((a, b) => new Date(a.start_time) - new Date(b.start_time)),
    [sessions]
  );

  const dates = useMemo(() => {
    const set = new Set();
    sortedSessions.forEach((s) => {
      if (s.start_time) set.add(new Date(s.start_time).toISOString().slice(0, 10));
    });
    return Array.from(set).sort();
  }, [sortedSessions]);

  const safeDateIdx = Math.min(selectedDateIdx, Math.max(0, dates.length - 1));

  const filteredSessions = useMemo(() => {
    return sortedSessions.filter((s) => {
      if (viewMode === "lista" && dates.length > 0) {
        const sDate = s.start_time ? new Date(s.start_time).toISOString().slice(0, 10) : null;
        if (sDate !== dates[safeDateIdx]) return false;
      }
      if (activeFilters.track_id && s.track_id !== activeFilters.track_id) return false;
      if (activeFilters.room_id && s.room_id !== activeFilters.room_id) return false;
      if (activeFilters.session_type && s.session_type !== activeFilters.session_type) return false;
      if (activeFilters.only_favs && !favSet.has(s.id)) return false;
      return true;
    });
  }, [sortedSessions, dates, safeDateIdx, activeFilters, favSet, viewMode]);

  const hasActiveFilters = activeFilters.track_id || activeFilters.room_id || activeFilters.session_type || activeFilters.only_favs;

  const applyFilters = () => { setActiveFilters({ ...pendingFilters }); setShowFilters(false); };
  const clearFilters = () => {
    const empty = { track_id: "", room_id: "", session_type: "", only_favs: false };
    setPendingFilters(empty); setActiveFilters(empty); setShowFilters(false);
  };

  if (isLoading) {
    return <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (sessions.length === 0) {
    return <div className="text-center py-12 text-muted-foreground"><Calendar className="w-10 h-10 mx-auto mb-3 opacity-30" /><p>Nenhuma sessão cadastrada ainda.</p></div>;
  }

  // For grid mode, use all filtered sessions regardless of selected date
  const gridSessions = sortedSessions.filter((s) => {
    if (activeFilters.track_id && s.track_id !== activeFilters.track_id) return false;
    if (activeFilters.room_id && s.room_id !== activeFilters.room_id) return false;
    if (activeFilters.session_type && s.session_type !== activeFilters.session_type) return false;
    if (activeFilters.only_favs && !favSet.has(s.id)) return false;
    return true;
  });

  // Session to open (resolve full object from openSession id if needed)
  const openSessionObj = openSession;
  const openTrack = openSessionObj ? trackMap[openSessionObj.track_id] : null;
  const openRoom = openSessionObj ? roomMap[openSessionObj.room_id] : null;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {/* Date nav (lista mode only) */}
        {viewMode === "lista" && (
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="icon" className="h-11 w-11 sm:h-8 sm:w-8" disabled={safeDateIdx === 0} onClick={() => setSelectedDateIdx((i) => Math.max(0, i - 1))} aria-label="Data anterior">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="min-w-[130px] text-center">
              <p className="text-sm font-medium capitalize">{dates[safeDateIdx] ? formatDateLabel(dates[safeDateIdx]) : "—"}</p>
              {dates.length > 1 && <p className="text-xs text-muted-foreground">{safeDateIdx + 1}/{dates.length}</p>}
            </div>
            <Button variant="outline" size="icon" className="h-11 w-11 sm:h-8 sm:w-8" disabled={safeDateIdx >= dates.length - 1} onClick={() => setSelectedDateIdx((i) => Math.min(dates.length - 1, i + 1))} aria-label="Próxima data">
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}

        {/* Right controls */}
        <div className="flex items-center gap-2 ml-auto">
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
                {[activeFilters.track_id, activeFilters.room_id, activeFilters.session_type, activeFilters.only_favs].filter(Boolean).length}
              </span>
            )}
          </Button>
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button onClick={() => setViewMode("lista")}
              className={`px-2.5 py-1.5 transition-colors ${viewMode === "lista" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}>
              <LayoutList className="w-4 h-4" />
            </button>
            <button onClick={() => setViewMode("grid")}
              className={`px-2.5 py-1.5 border-l border-border transition-colors ${viewMode === "grid" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}>
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Filters panel */}
      {showFilters && (
        <div className="rounded-2xl border border-border bg-card p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { label: "Trilha", key: "track_id", opts: tracks.map((t) => ({ v: t.id, l: t.name })) },
              { label: "Sala", key: "room_id", opts: rooms.map((r) => ({ v: r.id, l: r.name })) },
              { label: "Tipo", key: "session_type", opts: Object.entries(SESSION_TYPE_LABELS).map(([v, l]) => ({ v, l })) },
            ].map(({ label, key, opts }) => (
              <div key={key} className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{label}</label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={pendingFilters[key]}
                  onChange={(e) => setPendingFilters((f) => ({ ...f, [key]: e.target.value }))}
                >
                  <option value="">Todos</option>
                  {opts.map(({ v, l }) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            ))}
          </div>
          {/* Somente favoritos */}
          {participant?.id && (
            <label className="flex items-center gap-2 text-sm cursor-pointer w-fit">
              <input
                type="checkbox"
                checked={!!pendingFilters.only_favs}
                onChange={(e) => setPendingFilters((f) => ({ ...f, only_favs: e.target.checked }))}
                className="rounded"
              />
              <Star className="w-4 h-4 text-amber-500" /> Somente favoritos
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={clearFilters}>
              <X className="w-3.5 h-3.5" /> Limpar
            </Button>
            <Button size="sm" onClick={applyFilters}>Salvar</Button>
          </div>
        </div>
      )}

      {/* Sessions */}
      {filteredSessions.length === 0 && viewMode === "lista" ? (
        <div className="text-center py-10 text-muted-foreground">
          <Calendar className="w-8 h-8 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Nenhuma sessão encontrada.</p>
          {hasActiveFilters && <button onClick={clearFilters} className="text-primary text-sm mt-2 hover:underline">Limpar filtros</button>}
        </div>
      ) : viewMode === "lista" ? (
        <div className="space-y-3">
          {filteredSessions.map((s) => (
            <SessionListItem
              key={s.id}
              session={s}
              track={trackMap[s.track_id]}
              room={roomMap[s.room_id]}
              isFav={favSet.has(s.id)}
              onToggleFav={() => toggleFavMut.mutate(s.id)}
              onClick={() => setOpenSession(s)}
            />
          ))}
        </div>
      ) : (
        <CalendarGrid
          sessions={gridSessions}
          trackMap={trackMap}
          roomMap={roomMap}
          dates={dates}
          favSet={favSet}
          onToggleFav={(id) => toggleFavMut.mutate(id)}
          onOpen={setOpenSession}
        />
      )}

      {/* Session detail modal */}
      {openSessionObj && (
        <SessionDetail
          session={openSessionObj}
          track={openTrack}
          room={openRoom}
          participant={participant}
          isReadOnly={isReadOnly}
          onClose={() => setOpenSession(null)}
        />
      )}
    </div>
  );
}
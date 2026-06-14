import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { useParams, useNavigate, Link } from "react-router-dom";
import { t } from "@/lib/i18n";
import { canManageEvent } from "@/lib/access";
import { logAudit } from "@/lib/audit";
import StatusBadge from "@/components/admin/StatusBadge";
import EntityTable from "@/components/admin/EntityTable";
import EntityFormDialog from "@/components/admin/EntityFormDialog";
import CsvImport from "@/components/admin/CsvImport";
import ColorPickerField from "@/components/admin/ColorPickerField";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Pencil, Users, Route, Layout, Handshake, UserCheck, Upload, DoorOpen, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export default function EventDetail() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("participants");
  const [formDialog, setFormDialog] = useState({ open: false, type: null, item: null });
  const [showImport, setShowImport] = useState(false);
  const [trackColorEdit, setTrackColorEdit] = useState(null);

  const { data: event, isLoading } = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => { const l = await base44.entities.Event.filter({ id: eventId }); return l[0]; },
  });

  const { data: participants = [] } = useQuery({
    queryKey: ["participants", eventId],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: tracks = [] } = useQuery({
    queryKey: ["tracks", eventId],
    queryFn: () => base44.entities.Track.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: rooms = [] } = useQuery({
    queryKey: ["rooms", eventId],
    queryFn: () => base44.entities.Room.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", eventId],
    queryFn: () => base44.entities.Session.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: partners = [] } = useQuery({
    queryKey: ["partners", eventId],
    queryFn: () => base44.entities.Partner.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: reps = [] } = useQuery({
    queryKey: ["reps", eventId],
    queryFn: () => base44.entities.PartnerRepresentative.filter({ event_id: eventId, is_deleted: false }),
  });

  const hasAccess = canManageEvent(user, eventId);

  // Backfill: create default track/room for existing events that don't have them
  useEffect(() => {
    if (!eventId || !event) return;
    const doBackfill = async () => {
      const [existingTracks, existingRooms] = await Promise.all([
        base44.entities.Track.filter({ event_id: eventId, is_deleted: false }),
        base44.entities.Room.filter({ event_id: eventId, is_deleted: false }),
      ]);
      const ops = [];
      if (existingTracks.length === 0) {
        ops.push(base44.entities.Track.create({ event_id: eventId, name: "Principal", color: "#4F46E5", is_deleted: false }));
      }
      if (existingRooms.length === 0) {
        ops.push(base44.entities.Room.create({ event_id: eventId, name: "Plenária", is_deleted: false }));
      }
      if (ops.length > 0) {
        await Promise.all(ops);
        queryClient.invalidateQueries({ queryKey: ["tracks", eventId] });
        queryClient.invalidateQueries({ queryKey: ["rooms", eventId] });
      }
    };
    doBackfill();
  }, [eventId, event]);

  const ENTITY_MAP = {
    participant: "Participant",
    track: "Track",
    room: "Room",
    session: "Session",
    partner: "Partner",
    rep: "PartnerRepresentative",
  };

  const saveMut = useMutation({
    mutationFn: async ({ type, data, id }) => {
      const eName = ENTITY_MAP[type];
      if (id) {
        await base44.entities[eName].update(id, data);
        return { id, action: "update" };
      } else {
        const created = await base44.entities[eName].create({ ...data, event_id: eventId, is_deleted: false });
        return { id: created.id, action: "create" };
      }
    },
    onSuccess: ({ id, action }, { type }) => {
      logAudit({ event_id: eventId, action, entity_type: ENTITY_MAP[type], entity_id: id, user });
      const qKey = type === "rep" ? "reps" : type + "s";
      queryClient.invalidateQueries({ queryKey: [qKey, eventId] });
      setFormDialog({ open: false, type: null, item: null });
      setTrackColorEdit(null);
      toast.success(t("events.saveSuccess"));
    },
  });

  const deleteMut = useMutation({
    mutationFn: async ({ type, id }) => {
      await base44.entities[ENTITY_MAP[type]].update(id, { is_deleted: true });
      return { type, id };
    },
    onSuccess: ({ type, id }) => {
      logAudit({ event_id: eventId, action: "soft_delete", entity_type: ENTITY_MAP[type], entity_id: id, user });
      const qKey = type === "rep" ? "reps" : type + "s";
      queryClient.invalidateQueries({ queryKey: [qKey, eventId] });
      toast.success(t("events.deleteSuccess"));
    },
  });

  // Team role toggle
  const toggleTeamRole = async (participant) => {
    const newRole = participant.role_in_event === "team" ? "attendee" : "team";
    await base44.entities.Participant.update(participant.id, { role_in_event: newRole });
    logAudit({ event_id: eventId, action: "role_change", entity_type: "Participant", entity_id: participant.id, user });
    queryClient.invalidateQueries({ queryKey: ["participants", eventId] });
    toast.success(t("events.saveSuccess"));
  };

  if (isLoading) return <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (!event) return <p className="text-center py-12 text-muted-foreground">{t("events.noEvents")}</p>;

  const openForm = (type, item = null) => setFormDialog({ open: true, type, item });

  const SESSION_TYPES = [
    { value: "aula", label: t("sessionTypes.aula") },
    { value: "debate", label: t("sessionTypes.debate") },
    { value: "demonstracao", label: t("sessionTypes.demonstracao") },
    { value: "keynote", label: t("sessionTypes.keynote") },
    { value: "mesa_redonda", label: t("sessionTypes.mesa_redonda") },
    { value: "palestra", label: t("sessionTypes.palestra") },
    { value: "painel", label: t("sessionTypes.painel") },
    { value: "simulacao", label: t("sessionTypes.simulacao") },
    { value: "workshop", label: t("sessionTypes.workshop") },
  ];

  const fieldDefs = {
    participant: [
      { key: "full_name", label: "Nome", required: true },
      { key: "email", label: "E-mail", type: "email", required: true },
      { key: "cpf", label: "CPF", required: true },
      { key: "phone", label: "Telefone", required: true },
      { key: "company", label: "Empresa" },
      { key: "job_title", label: "Cargo" },
      { key: "linkedin", label: "LinkedIn" },
      { key: "instagram", label: "Instagram" },
      { key: "youtube", label: "Youtube" },
      { key: "website", label: "Site" },
      { key: "bio", label: "Sobre mim", type: "textarea" },
      { key: "role_in_event", label: "Papel", type: "select", options: [
        { value: "attendee", label: t("roles.attendee") },
        { value: "speaker", label: t("roles.speaker") },
        { value: "team", label: t("roles.team") },
        { value: "manager", label: t("roles.manager") },
      ]},
    ],
    track: [
      { key: "name", label: "Nome", required: true },
      { key: "description", label: "Descrição", type: "textarea" },
      // color handled separately via ColorPickerField
    ],
    room: [
      { key: "name", label: "Nome", required: true },
      { key: "capacity", label: "Capacidade", type: "number" },
      { key: "floor", label: "Andar" },
      { key: "block", label: "Bloco" },
    ],
    session: [
      { key: "title", label: "Título", required: true },
      { key: "description", label: "Descrição", type: "textarea" },
      { key: "speaker_name", label: "Palestrante" },
      { key: "start_time", label: "Início", type: "datetime-local", required: true },
      { key: "end_time", label: "Término", type: "datetime-local" },
      { key: "track_id", label: "Trilha *", type: "select", required: true, options: tracks.map((tr) => ({ value: tr.id, label: tr.name })) },
      { key: "room_id", label: "Sala *", type: "select", required: true, options: rooms.map((r) => ({ value: r.id, label: r.name })) },
      { key: "capacity", label: "Capacidade", type: "number" },
      { key: "session_type", label: "Tipo de Sessão", type: "select", options: SESSION_TYPES },
    ],
    partner: [
      { key: "name", label: "Nome", required: true },
      { key: "website", label: "Website" },
      { key: "contact_email", label: "E-mail de Contato" },
      { key: "plan", label: "Plano", type: "select", options: [
        { value: "diamante", label: t("plans.diamante") },
        { value: "ouro", label: t("plans.ouro") },
        { value: "prata", label: t("plans.prata") },
        { value: "bronze", label: t("plans.bronze") },
        { value: "apoiador", label: t("plans.apoiador") },
      ]},
    ],
    rep: [
      { key: "partner_id", label: "Parceiro *", type: "select", required: true, options: partners.map((p) => ({ value: p.id, label: p.name })) },
      { key: "full_name", label: "Nome", required: true },
      { key: "email", label: "E-mail", type: "email", required: true },
      { key: "phone", label: "Telefone" },
      { key: "role", label: "Função" },
    ],
  };

  const brandStyle = {
    "--ev-primary": event.color_primary || "#4F46E5",
    "--ev-secondary": event.color_secondary || "#0D9488",
    "--ev-accent": event.color_accent || "#F59E0B",
  };

  const trackName = (id) => tracks.find((t) => t.id === id)?.name || "—";
  const roomName = (id) => rooms.find((r) => r.id === id)?.name || "—";
  const partnerName = (id) => partners.find((p) => p.id === id)?.name || "—";

  return (
    <div className="space-y-4" style={brandStyle}>
      {/* Header */}
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/events")} className="mt-1 shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            {event.logo_url ? (
              <img src={event.logo_url} alt="" className="w-12 h-12 rounded-xl object-cover" />
            ) : (
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg" style={{ backgroundColor: event.color_primary || "#4F46E5" }}>
                {event.name?.[0]?.toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-xl font-display font-bold">{event.name}</h1>
              <div className="flex items-center gap-2 mt-1">
                <StatusBadge status={event.status} />
                <span className="text-xs text-muted-foreground">{event.manager_name}</span>
              </div>
            </div>
          </div>
          <div className="flex gap-1 mt-3">
            <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: event.color_primary }} />
            <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: event.color_secondary }} />
            <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: event.color_accent }} />
          </div>
        </div>
        {hasAccess && (
          <Link to={`/events/${eventId}/edit`}>
            <Button variant="outline" size="sm" className="gap-1 shrink-0">
              <Pencil className="w-4 h-4" />
              <span className="hidden sm:inline">{t("common.edit")}</span>
            </Button>
          </Link>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full justify-start overflow-x-auto flex-nowrap">
          <TabsTrigger value="participants" className="gap-1">
            <Users className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.participants")}</span><span className="sm:hidden">Part.</span>
          </TabsTrigger>
          <TabsTrigger value="tracks" className="gap-1">
            <Route className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.tracks")}</span><span className="sm:hidden">Tri.</span>
          </TabsTrigger>
          <TabsTrigger value="rooms" className="gap-1">
            <DoorOpen className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.rooms")}</span><span className="sm:hidden">Sal.</span>
          </TabsTrigger>
          <TabsTrigger value="sessions" className="gap-1">
            <Layout className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.sessions")}</span><span className="sm:hidden">Ses.</span>
          </TabsTrigger>
          <TabsTrigger value="partners" className="gap-1">
            <Handshake className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.partners")}</span><span className="sm:hidden">Par.</span>
          </TabsTrigger>
          <TabsTrigger value="reps" className="gap-1">
            <UserCheck className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.representatives")}</span><span className="sm:hidden">Rep.</span>
          </TabsTrigger>
          <TabsTrigger value="team" className="gap-1">
            <UsersRound className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.team")}</span><span className="sm:hidden">Eq.</span>
          </TabsTrigger>
        </TabsList>

        {/* Participantes */}
        <TabsContent value="participants" className="mt-4">
          {showImport ? (
            <CsvImport eventId={eventId} existingParticipants={participants} onComplete={() => setShowImport(false)} />
          ) : (
            <>
              <div className="flex gap-2 mb-3 justify-end">
                <Button variant="outline" size="sm" className="gap-1" onClick={() => setShowImport(true)}>
                  <Upload className="w-4 h-4" /> CSV
                </Button>
              </div>
              <EntityTable
                items={participants}
                columns={[
                  { key: "full_name", label: "Nome" },
                  { key: "email", label: "E-mail" },
                  { key: "phone", label: "Telefone" },
                  { key: "role_in_event", label: "Papel", render: (p) => t(`roles.${p.role_in_event}`) || p.role_in_event },
                ]}
                searchField="full_name"
                onAdd={hasAccess ? () => openForm("participant") : undefined}
                onEdit={hasAccess ? (item) => openForm("participant", item) : undefined}
                onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "participant", id: item.id }) : undefined}
                addLabel="Novo"
              />
            </>
          )}
        </TabsContent>

        {/* Trilhas */}
        <TabsContent value="tracks" className="mt-4">
          <div className="space-y-2">
            {tracks.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">{t("common.noData")}</p>}
            {tracks.map((track) => (
              <div key={track.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
                <div className="w-5 h-5 rounded-full shrink-0" style={{ backgroundColor: track.color || "#94a3b8" }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{track.name}</p>
                  {track.description && <p className="text-xs text-muted-foreground truncate">{track.description}</p>}
                </div>
                {hasAccess && (
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setTrackColorEdit({ id: track.id, color: track.color || "#4F46E5", name: track.name, description: track.description })}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => deleteMut.mutate({ type: "track", id: track.id })}>
                      <span className="text-xs">✕</span>
                    </Button>
                  </div>
                )}
              </div>
            ))}
            {hasAccess && (
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setTrackColorEdit({ id: null, color: "#4F46E5", name: "", description: "" })}>
                + Nova Trilha
              </Button>
            )}
          </div>
        </TabsContent>

        {/* Salas */}
        <TabsContent value="rooms" className="mt-4">
          <EntityTable
            items={rooms}
            columns={[
              { key: "name", label: "Nome" },
              { key: "capacity", label: "Capacidade" },
              { key: "floor", label: "Andar" },
              { key: "block", label: "Bloco" },
            ]}
            searchField="name"
            onAdd={hasAccess ? () => openForm("room") : undefined}
            onEdit={hasAccess ? (item) => openForm("room", item) : undefined}
            onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "room", id: item.id }) : undefined}
            addLabel="Nova"
          />
        </TabsContent>

        {/* Sessões */}
        <TabsContent value="sessions" className="mt-4">
          <EntityTable
            items={sessions}
            columns={[
              { key: "title", label: "Título" },
              { key: "track_id", label: "Trilha", render: (s) => trackName(s.track_id) },
              { key: "room_id", label: "Sala", render: (s) => roomName(s.room_id) },
              { key: "start_time", label: "Início", render: (s) => s.start_time ? new Date(s.start_time).toLocaleString("pt-BR") : "—" },
            ]}
            searchField="title"
            onAdd={hasAccess ? () => openForm("session") : undefined}
            onEdit={hasAccess ? (item) => openForm("session", item) : undefined}
            onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "session", id: item.id }) : undefined}
            addLabel="Nova"
          />
        </TabsContent>

        {/* Parceiros */}
        <TabsContent value="partners" className="mt-4">
          <EntityTable
            items={partners}
            columns={[
              { key: "name", label: "Nome" },
              { key: "plan", label: "Plano", render: (p) => t(`plans.${p.plan}`) || p.plan },
              { key: "contact_email", label: "Contato" },
            ]}
            searchField="name"
            onAdd={hasAccess ? () => openForm("partner") : undefined}
            onEdit={hasAccess ? (item) => openForm("partner", item) : undefined}
            onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "partner", id: item.id }) : undefined}
            addLabel="Novo"
          />
        </TabsContent>

        {/* Representantes */}
        <TabsContent value="reps" className="mt-4">
          <EntityTable
            items={reps}
            columns={[
              { key: "full_name", label: "Nome" },
              { key: "partner_id", label: "Parceiro", render: (r) => partnerName(r.partner_id) },
              { key: "email", label: "E-mail" },
              { key: "role", label: "Função" },
            ]}
            onAdd={hasAccess ? () => openForm("rep") : undefined}
            onEdit={hasAccess ? (item) => openForm("rep", item) : undefined}
            onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "rep", id: item.id }) : undefined}
            addLabel="Novo"
          />
        </TabsContent>

        {/* Equipe */}
        <TabsContent value="team" className="mt-4">
          <TeamTab participants={participants} hasAccess={hasAccess} onToggle={toggleTeamRole} />
        </TabsContent>
      </Tabs>

      {/* Generic Form Dialog */}
      {formDialog.open && (
        <EntityFormDialog
          open={formDialog.open}
          onOpenChange={(open) => !open && setFormDialog({ open: false, type: null, item: null })}
          title={formDialog.item ? t("common.edit") : "Novo"}
          fields={fieldDefs[formDialog.type] || []}
          item={formDialog.item}
          onSubmit={(data) => saveMut.mutate({ type: formDialog.type, data, id: formDialog.item?.id })}
          isSubmitting={saveMut.isPending}
        />
      )}

      {/* Track color/name dialog */}
      {trackColorEdit !== null && (
        <TrackEditDialog
          item={trackColorEdit}
          onSave={(data) => saveMut.mutate({ type: "track", data, id: trackColorEdit.id || undefined })}
          onClose={() => setTrackColorEdit(null)}
          isSubmitting={saveMut.isPending}
        />
      )}
    </div>
  );
}

// ── Track edit dialog with color picker ──────────────────────────────────────
function TrackEditDialog({ item, onSave, onClose, isSubmitting }) {
  const [name, setName] = useState(item.name || "");
  const [description, setDescription] = useState(item.description || "");
  const [color, setColor] = useState(item.color || "#4F46E5");

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({ name, description, color });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">{item.id ? t("common.edit") : "Nova Trilha"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Nome *</Label>
            <input
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>Descrição</Label>
            <textarea
              className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <ColorPickerField value={color} onChange={setColor} label="Cor da Trilha" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={isSubmitting}>{isSubmitting ? t("common.loading") : t("common.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Team tab ──────────────────────────────────────────────────────────────────
function TeamTab({ participants, hasAccess, onToggle }) {
  const [search, setSearch] = useState("");
  const filtered = participants.filter((p) =>
    p.full_name?.toLowerCase().includes(search.toLowerCase()) ||
    p.email?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Associe ou remova o papel <strong>Equipe</strong> em participantes já cadastrados. Não é possível criar novas pessoas aqui.
      </p>
      <input
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        placeholder="Buscar participante..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="space-y-2">
        {filtered.map((p) => {
          const isTeam = p.role_in_event === "team";
          return (
            <div key={p.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-border bg-card">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{p.full_name}</p>
                <p className="text-xs text-muted-foreground truncate">{p.email}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="secondary" className={isTeam ? "bg-indigo-100 text-indigo-700" : "bg-muted text-muted-foreground"}>
                  {isTeam ? t("roles.team") : t("roles.attendee")}
                </Badge>
                {hasAccess && (
                  <Button
                    variant={isTeam ? "destructive" : "outline"}
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => onToggle(p)}
                  >
                    {isTeam ? "Remover" : "Equipe"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-center text-muted-foreground py-6 text-sm">{t("common.noData")}</p>
        )}
      </div>
    </div>
  );
}
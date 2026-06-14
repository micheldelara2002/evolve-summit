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
import ColorPickerField from "@/components/admin/ColorPickerField";
import PessoasTab from "@/components/admin/PessoasTab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Pencil, Users, Route, Layout, Handshake, DoorOpen, Plus } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter as ADF, AlertDialogHeader, AlertDialogTitle as ADT } from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";

export default function EventDetail() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("pessoas");
  const [formDialog, setFormDialog] = useState({ open: false, type: null, item: null });
  const [showImport, setShowImport] = useState(false);
  const [trackColorEdit, setTrackColorEdit] = useState(null);
  const [trackDeleteConfirm, setTrackDeleteConfirm] = useState(null);

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

  const ENTITY_MAP = { track: "Track", room: "Room", session: "Session", partner: "Partner" };

  const saveMut = useMutation({
    mutationFn: async ({ type, data, id }) => {
      const eName = ENTITY_MAP[type];
      // For sessions: resolve speaker_name from speaker_id
      let finalData = { ...data };
      if (type === "session" && data.speaker_id) {
        const spk = participants.find((p) => p.id === data.speaker_id);
        if (spk) finalData.speaker_name = spk.full_name;
      }
      if (id) {
        await base44.entities[eName].update(id, finalData);
        return { id, action: "update" };
      } else {
        const created = await base44.entities[eName].create({ ...finalData, event_id: eventId, is_deleted: false });
        return { id: created.id, action: "create" };
      }
    },
    onSuccess: (res, { type }) => {
      if (res?.action) logAudit({ event_id: eventId, action: res.action, entity_type: ENTITY_MAP[type], entity_id: res.id, user });
      queryClient.invalidateQueries({ queryKey: [type + "s", eventId] });
      setFormDialog({ open: false, type: null, item: null });
      setTrackColorEdit(null);
      toast.success(t("events.saveSuccess"));
    },
  });

  const deleteMut = useMutation({
    mutationFn: async ({ type, id }) => {
      // Guard: last track/room
      if (type === "track") {
        if (tracks.length <= 1) throw new Error("Deve haver pelo menos uma trilha cadastrada.");
        const linked = sessions.some((s) => s.track_id === id);
        if (linked) throw new Error("Não é possível excluir: já existe sessão cadastrada nesta trilha.");
      }
      if (type === "room") {
        if (rooms.length <= 1) throw new Error("Deve haver pelo menos uma sala cadastrada.");
        const linked = sessions.some((s) => s.room_id === id);
        if (linked) throw new Error("Não é possível excluir: já existe sessão cadastrada nesta sala.");
      }
      if (type === "partner") {
        const hasReps = reps.some((r) => r.partner_id === id);
        if (hasReps) throw new Error("Para excluir este parceiro, desassocie os representantes vinculados.");
      }
      await base44.entities[ENTITY_MAP[type]].update(id, { is_deleted: true });
      return { type, id };
    },
    onSuccess: ({ type, id }) => {
      logAudit({ event_id: eventId, action: "soft_delete", entity_type: ENTITY_MAP[type], entity_id: id, user });
      queryClient.invalidateQueries({ queryKey: [type + "s", eventId] });
      toast.success(t("events.deleteSuccess"));
    },
    onError: (err) => {
      toast.error(err.message || "Erro ao excluir.");
    },
  });

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
    room: [
      { key: "name", label: "Nome", required: true },
      { key: "capacity", label: "Capacidade", type: "number" },
      { key: "floor", label: "Andar" },
      { key: "block", label: "Bloco" },
    ],
    session: [
      { key: "title", label: "Título", required: true },
      { key: "description", label: "Descrição", type: "textarea" },
      { key: "speaker_id", label: "Palestrante", type: "select", options: [{ value: "", label: "— nenhum —" }, ...participants.filter((p) => p.role_in_event === "speaker").map((p) => ({ value: p.id, label: p.full_name }))] },
      { key: "start_time", label: "Início", type: "datetime-local", required: true },
      { key: "end_time", label: "Término", type: "datetime-local" },
      { key: "track_id", label: "Trilha", type: "select", required: true, options: tracks.map((tr) => ({ value: tr.id, label: tr.name })) },
      { key: "room_id", label: "Sala", type: "select", required: true, options: rooms.map((r) => ({ value: r.id, label: r.name })) },
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
  };

  const trackName = (id) => tracks.find((tr) => tr.id === id)?.name || "—";
  const roomName = (id) => rooms.find((r) => r.id === id)?.name || "—";

  return (
    <div className="space-y-4">
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
          <TabsTrigger value="pessoas" className="gap-1">
            <Users className="w-3.5 h-3.5" /><span className="hidden sm:inline">Pessoas</span><span className="sm:hidden">Pess.</span>
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
        </TabsList>

        {/* ── Pessoas do Evento (tela única) ── */}
        <TabsContent value="pessoas" className="mt-4">
          <PessoasTab
            eventId={eventId}
            participants={participants}
            reps={reps}
            partners={partners}
            sessions={sessions}
            hasAccess={hasAccess}
            showImport={showImport}
            onShowImport={() => setShowImport(true)}
            onHideImport={() => setShowImport(false)}
          />
        </TabsContent>

        {/* ── Trilhas ── */}
        <TabsContent value="tracks" className="mt-4">
          <div className="space-y-3">
            {/* Toolbar: busca + botão Nova ao topo */}
            <div className="flex items-center gap-2">
              <div className="flex-1" />
              {hasAccess && (
                <Button size="sm" className="gap-1 shrink-0" onClick={() => setTrackColorEdit({ id: null, color: "#4F46E5", name: "", description: "" })}>
                  <Plus className="w-4 h-4" /> Nova
                </Button>
              )}
            </div>
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
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setTrackDeleteConfirm(track)}>
                      <span className="text-xs">✕</span>
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </TabsContent>

        {/* ── Salas ── */}
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

        {/* ── Sessões ── */}
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

        {/* ── Parceiros ── */}
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
      </Tabs>

      {/* Generic Form Dialog (rooms, sessions, partners) */}
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

      {/* Track delete confirm */}
      {trackDeleteConfirm && (
        <TrackDeleteDialog
          track={trackDeleteConfirm}
          onConfirm={() => { deleteMut.mutate({ type: "track", id: trackDeleteConfirm.id }); setTrackDeleteConfirm(null); }}
          onClose={() => setTrackDeleteConfirm(null)}
        />
      )}

      {/* Track edit dialog */}
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

// ── Track delete confirm dialog ──────────────────────────────────────────────
function TrackDeleteDialog({ track, onConfirm, onClose }) {
  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <ADT>Confirmar exclusão</ADT>
          <AlertDialogDescription>
            Tem certeza que deseja excluir a trilha <strong>{track.name}</strong>?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ADF>
          <AlertDialogCancel onClick={onClose}>Cancelar</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={onConfirm}>
            Excluir
          </AlertDialogAction>
        </ADF>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Track edit dialog ────────────────────────────────────────────────────────
function TrackEditDialog({ item, onSave, onClose, isSubmitting }) {
  const [name, setName] = useState(item.name || "");
  const [description, setDescription] = useState(item.description || "");
  const [color, setColor] = useState(item.color || "#4F46E5");

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">{item.id ? t("common.edit") : "Nova Trilha"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); onSave({ name, description, color }); }} className="space-y-4">
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
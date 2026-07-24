import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { logAudit } from "@/lib/audit";
import { t } from "@/lib/i18n";
import EntityTable from "@/components/admin/EntityTable";
import EntityFormDialog from "@/components/admin/EntityFormDialog";
import ColorPickerField from "@/components/admin/ColorPickerField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter as ADF, AlertDialogHeader, AlertDialogTitle as ADT } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Search, MoreVertical } from "lucide-react";

const ENTITY_MAP = { track: "Track", room: "Room", session: "Session" };

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

export default function EventStructureManager({ eventId, hasAccess, user, module: mod }) {
  const queryClient = useQueryClient();
  const [formDialog, setFormDialog] = useState({ open: false, type: null, item: null });
  const [trackColorEdit, setTrackColorEdit] = useState(null);
  const [trackDeleteConfirm, setTrackDeleteConfirm] = useState(null);
  const [trackBlockMsg, setTrackBlockMsg] = useState(null);

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
  const { data: participants = [] } = useQuery({
    queryKey: ["participants", eventId],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
  });

  const saveMut = useMutation({
    mutationFn: async ({ type, data, id }) => {
      const eName = ENTITY_MAP[type];
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

  const openForm = (type, item = null) => setFormDialog({ open: true, type, item });

  const fieldDefs = {
    room: [
      { key: "name", label: "Nome", required: true },
      { key: "capacity", label: "Capacidade", type: "number", required: false },
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
  };

  const trackName = (id) => tracks.find((tr) => tr.id === id)?.name || "—";
  const roomName = (id) => rooms.find((r) => r.id === id)?.name || "—";

  return (
    <>
      {mod === "tracks" && (
        <TracksList
          tracks={tracks}
          sessions={sessions}
          hasAccess={hasAccess}
          onNew={() => setTrackColorEdit({ id: null, color: "#4F46E5", name: "", description: "" })}
          onEdit={(track) => setTrackColorEdit({ id: track.id, color: track.color || "#4F46E5", name: track.name, description: track.description })}
          onDelete={(track) => {
            if (tracks.length <= 1) { setTrackBlockMsg("Deve haver pelo menos uma trilha cadastrada."); return; }
            if (sessions.some((s) => s.track_id === track.id)) { setTrackBlockMsg("Não é possível excluir esta trilha, pois há sessão(ões) vinculada(s) a ela."); return; }
            setTrackDeleteConfirm(track);
          }}
        />
      )}
      {mod === "rooms" && (
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
          canDelete={(item) => {
            if (rooms.length <= 1) return "Deve haver pelo menos uma sala cadastrada.";
            if (sessions.some((s) => s.room_id === item.id)) return "Não é possível excluir: já existe sessão cadastrada nesta sala.";
            return null;
          }}
          onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "room", id: item.id }) : undefined}
          addLabel="Nova"
        />
      )}
      {mod === "sessions" && (
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
      )}

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

      <AlertDialog open={!!trackBlockMsg} onOpenChange={() => setTrackBlockMsg(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <ADT>Não é possível excluir</ADT>
            <AlertDialogDescription>{trackBlockMsg}</AlertDialogDescription>
          </AlertDialogHeader>
          <ADF>
            <AlertDialogAction onClick={() => setTrackBlockMsg(null)}>OK</AlertDialogAction>
          </ADF>
        </AlertDialogContent>
      </AlertDialog>

      {trackDeleteConfirm && (
        <TrackDeleteDialog
          track={trackDeleteConfirm}
          onConfirm={() => { deleteMut.mutate({ type: "track", id: trackDeleteConfirm.id }); setTrackDeleteConfirm(null); }}
          onClose={() => setTrackDeleteConfirm(null)}
        />
      )}

      {trackColorEdit !== null && (
        <TrackEditDialog
          item={trackColorEdit}
          onSave={(data) => saveMut.mutate({ type: "track", data, id: trackColorEdit.id || undefined })}
          onClose={() => setTrackColorEdit(null)}
          isSubmitting={saveMut.isPending}
        />
      )}
    </>
  );
}

function TracksList({ tracks, sessions, hasAccess, onNew, onEdit, onDelete }) {
  const [search, setSearch] = useState("");
  const filtered = tracks.filter((tr) => tr.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar trilha..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        {hasAccess && (
          <Button size="sm" className="gap-1 shrink-0" onClick={onNew}>
            <Plus className="w-4 h-4" /> Nova
          </Button>
        )}
      </div>
      {filtered.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">{t("common.noData")}</p>}
      {filtered.map((track) => (
        <div key={track.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
          <div className="w-5 h-5 rounded-full shrink-0" style={{ backgroundColor: track.color || "#94a3b8" }} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{track.name}</p>
            {track.description && <p className="text-xs text-muted-foreground truncate">{track.description}</p>}
          </div>
          {hasAccess && (
            <TrackActionsMenu onEdit={() => onEdit(track)} onDelete={() => onDelete(track)} />
          )}
        </div>
      ))}
    </div>
  );
}

function TrackActionsMenu({ onEdit, onDelete }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
          <MoreVertical className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="w-4 h-4 mr-2" /> Editar
        </DropdownMenuItem>
        <DropdownMenuItem className="text-destructive" onClick={onDelete}>
          <Trash2 className="w-4 h-4 mr-2" /> Excluir
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
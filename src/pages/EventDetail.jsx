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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Pencil, Users, Mic2, Route, Layout, Handshake, UserCheck, Upload } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

export default function EventDetail() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("participants");
  const [formDialog, setFormDialog] = useState({ open: false, type: null, item: null });
  const [showImport, setShowImport] = useState(false);

  const { data: event, isLoading } = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => { const l = await base44.entities.Event.filter({ id: eventId }); return l[0]; },
  });

  const { data: participants = [] } = useQuery({
    queryKey: ["participants", eventId],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: speakers = [] } = useQuery({
    queryKey: ["speakers", eventId],
    queryFn: () => base44.entities.Speaker.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: tracks = [] } = useQuery({
    queryKey: ["tracks", eventId],
    queryFn: () => base44.entities.Track.filter({ event_id: eventId, is_deleted: false }),
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

  const saveMut = useMutation({
    mutationFn: async ({ type, data, id }) => {
      const entityMap = {
        participant: "Participant",
        speaker: "Speaker",
        track: "Track",
        session: "Session",
        partner: "Partner",
        rep: "PartnerRepresentative",
      };
      const eName = entityMap[type];
      if (id) {
        await base44.entities[eName].update(id, data);
        return { id, action: "update" };
      } else {
        const created = await base44.entities[eName].create({ ...data, event_id: eventId, is_deleted: false });
        return { id: created.id, action: "create" };
      }
    },
    onSuccess: ({ id, action }, { type }) => {
      const entityMap = { participant: "Participant", speaker: "Speaker", track: "Track", session: "Session", partner: "Partner", rep: "PartnerRepresentative" };
      logAudit({ event_id: eventId, action, entity_type: entityMap[type], entity_id: id, user });
      queryClient.invalidateQueries({ queryKey: [type + "s", eventId] });
      if (type === "rep") queryClient.invalidateQueries({ queryKey: ["reps", eventId] });
      setFormDialog({ open: false, type: null, item: null });
      toast.success(t("events.saveSuccess"));
    },
  });

  const deleteMut = useMutation({
    mutationFn: async ({ type, id }) => {
      const entityMap = { participant: "Participant", speaker: "Speaker", track: "Track", session: "Session", partner: "Partner", rep: "PartnerRepresentative" };
      await base44.entities[entityMap[type]].update(id, { is_deleted: true });
      return { type, id };
    },
    onSuccess: ({ type, id }) => {
      const entityMap = { participant: "Participant", speaker: "Speaker", track: "Track", session: "Session", partner: "Partner", rep: "PartnerRepresentative" };
      logAudit({ event_id: eventId, action: "soft_delete", entity_type: entityMap[type], entity_id: id, user });
      queryClient.invalidateQueries({ queryKey: [type + "s", eventId] });
      if (type === "rep") queryClient.invalidateQueries({ queryKey: ["reps", eventId] });
      toast.success(t("events.deleteSuccess"));
    },
  });

  if (isLoading) return <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (!event) return <p className="text-center py-12 text-muted-foreground">{t("events.noEvents")}</p>;

  const openForm = (type, item = null) => setFormDialog({ open: true, type, item });

  // Field definitions per entity type
  const fieldDefs = {
    participant: [
      { key: "full_name", label: "Nome", required: true },
      { key: "email", label: "E-mail", type: "email", required: true },
      { key: "cpf", label: "CPF" },
      { key: "phone", label: "Telefone" },
      { key: "company", label: "Empresa" },
      { key: "role_in_event", label: "Papel", type: "select", options: [
        { value: "attendee", label: "Participante" },
        { value: "vip", label: "VIP" },
        { value: "speaker", label: "Palestrante" },
        { value: "organizer", label: "Organizador" },
      ]},
    ],
    speaker: [
      { key: "full_name", label: "Nome", required: true },
      { key: "email", label: "E-mail", type: "email", required: true },
      { key: "bio", label: "Biografia", type: "textarea" },
      { key: "company", label: "Empresa" },
      { key: "title", label: "Cargo" },
    ],
    track: [
      { key: "name", label: "Nome", required: true },
      { key: "description", label: "Descrição", type: "textarea" },
      { key: "color", label: "Cor" },
    ],
    session: [
      { key: "title", label: "Título", required: true },
      { key: "description", label: "Descrição", type: "textarea" },
      { key: "speaker_name", label: "Palestrante" },
      { key: "start_time", label: "Início", type: "datetime-local", required: true },
      { key: "end_time", label: "Término", type: "datetime-local" },
      { key: "location", label: "Sala" },
      { key: "capacity", label: "Capacidade", type: "number" },
      { key: "session_type", label: "Tipo", type: "select", options: [
        { value: "talk", label: "Palestra" },
        { value: "workshop", label: "Workshop" },
        { value: "panel", label: "Painel" },
        { value: "networking", label: "Networking" },
        { value: "other", label: "Outro" },
      ]},
    ],
    partner: [
      { key: "name", label: "Nome", required: true },
      { key: "website", label: "Website" },
      { key: "contact_email", label: "E-mail de Contato" },
      { key: "tier", label: "Nível", type: "select", options: [
        { value: "platinum", label: t("tiers.platinum") },
        { value: "gold", label: t("tiers.gold") },
        { value: "silver", label: t("tiers.silver") },
        { value: "bronze", label: t("tiers.bronze") },
        { value: "supporter", label: t("tiers.supporter") },
      ]},
    ],
    rep: [
      { key: "full_name", label: "Nome", required: true },
      { key: "email", label: "E-mail", type: "email", required: true },
      { key: "phone", label: "Telefone" },
      { key: "role", label: "Função" },
      { key: "partner_id", label: "Parceiro", type: "select", options: partners.map((p) => ({ value: p.id, label: p.name })) },
    ],
  };

  const brandStyle = {
    "--ev-primary": event.color_primary || "#4F46E5",
    "--ev-secondary": event.color_secondary || "#0D9488",
    "--ev-accent": event.color_accent || "#F59E0B",
  };

  return (
    <div className="space-y-4" style={brandStyle}>
      {/* Header with branding */}
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
          {/* Color bar */}
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
          <TabsTrigger value="participants" className="gap-1"><Users className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.participants")}</span><span className="sm:hidden">Part.</span></TabsTrigger>
          <TabsTrigger value="speakers" className="gap-1"><Mic2 className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.speakers")}</span><span className="sm:hidden">Pal.</span></TabsTrigger>
          <TabsTrigger value="tracks" className="gap-1"><Route className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.tracks")}</span><span className="sm:hidden">Tri.</span></TabsTrigger>
          <TabsTrigger value="sessions" className="gap-1"><Layout className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.sessions")}</span><span className="sm:hidden">Ses.</span></TabsTrigger>
          <TabsTrigger value="partners" className="gap-1"><Handshake className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.partners")}</span><span className="sm:hidden">Par.</span></TabsTrigger>
          <TabsTrigger value="reps" className="gap-1"><UserCheck className="w-3.5 h-3.5" /><span className="hidden sm:inline">{t("events.representatives")}</span><span className="sm:hidden">Rep.</span></TabsTrigger>
        </TabsList>

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
                  { key: "company", label: "Empresa" },
                  { key: "role_in_event", label: "Papel" },
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

        <TabsContent value="speakers" className="mt-4">
          <EntityTable
            items={speakers}
            columns={[
              { key: "full_name", label: "Nome" },
              { key: "email", label: "E-mail" },
              { key: "company", label: "Empresa" },
              { key: "title", label: "Cargo" },
            ]}
            onAdd={hasAccess ? () => openForm("speaker") : undefined}
            onEdit={hasAccess ? (item) => openForm("speaker", item) : undefined}
            onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "speaker", id: item.id }) : undefined}
            addLabel="Novo"
          />
        </TabsContent>

        <TabsContent value="tracks" className="mt-4">
          <EntityTable
            items={tracks}
            columns={[
              { key: "name", label: "Nome" },
              { key: "description", label: "Descrição" },
            ]}
            searchField="name"
            onAdd={hasAccess ? () => openForm("track") : undefined}
            onEdit={hasAccess ? (item) => openForm("track", item) : undefined}
            onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "track", id: item.id }) : undefined}
            addLabel="Nova"
          />
        </TabsContent>

        <TabsContent value="sessions" className="mt-4">
          <EntityTable
            items={sessions}
            columns={[
              { key: "title", label: "Título" },
              { key: "speaker_name", label: "Palestrante" },
              { key: "start_time", label: "Início", render: (s) => s.start_time ? new Date(s.start_time).toLocaleString("pt-BR") : "—" },
              { key: "location", label: "Sala" },
            ]}
            searchField="title"
            onAdd={hasAccess ? () => openForm("session") : undefined}
            onEdit={hasAccess ? (item) => openForm("session", item) : undefined}
            onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "session", id: item.id }) : undefined}
            addLabel="Nova"
          />
        </TabsContent>

        <TabsContent value="partners" className="mt-4">
          <EntityTable
            items={partners}
            columns={[
              { key: "name", label: "Nome" },
              { key: "tier", label: "Nível", render: (p) => t(`tiers.${p.tier}`) || p.tier },
              { key: "contact_email", label: "Contato" },
            ]}
            searchField="name"
            onAdd={hasAccess ? () => openForm("partner") : undefined}
            onEdit={hasAccess ? (item) => openForm("partner", item) : undefined}
            onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "partner", id: item.id }) : undefined}
            addLabel="Novo"
          />
        </TabsContent>

        <TabsContent value="reps" className="mt-4">
          <EntityTable
            items={reps}
            columns={[
              { key: "full_name", label: "Nome" },
              { key: "email", label: "E-mail" },
              { key: "role", label: "Função" },
              { key: "partner_id", label: "Parceiro", render: (r) => partners.find((p) => p.id === r.partner_id)?.name || "—" },
            ]}
            onAdd={hasAccess ? () => openForm("rep") : undefined}
            onEdit={hasAccess ? (item) => openForm("rep", item) : undefined}
            onDelete={hasAccess ? (item) => deleteMut.mutate({ type: "rep", id: item.id }) : undefined}
            addLabel="Novo"
          />
        </TabsContent>
      </Tabs>

      {/* Form Dialog */}
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
    </div>
  );
}
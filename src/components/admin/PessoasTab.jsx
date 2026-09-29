/**
 * Tela única "Pessoas do Evento" (container — P3 componentização).
 * Fluxo: busca Person global → associa ao evento (upsert Participant)
 *        ou cria nova Person e associa automaticamente.
 * Tabela/ferramentas e diálogos extraídos em ./pessoas/*.
 * - partner_rep NÃO é atribuído manualmente aqui (vem da tela de Partner).
 */
import { useState, useMemo, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { logAudit } from "@/lib/audit";
import { decParticipantCounter } from "@/lib/businessCounters";
import { t } from "@/lib/i18n";
import { toast } from "sonner";
import CsvImport from "@/components/admin/CsvImport";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import QRScanner from "@/components/participante/QRScanner";
import { checkinTicket } from "@/lib/commerceApi";
import { updateParticipant, softDeleteParticipant, getEventReviewers } from "@/lib/participantApi";
import PessoasToolbar from "@/components/admin/pessoas/PessoasToolbar";
import PessoasTable from "@/components/admin/pessoas/PessoasTable";
import AddPersonToEventDialog from "@/components/admin/pessoas/AddPersonToEventDialog";
import EditParticipantDataDialog from "@/components/admin/pessoas/EditParticipantDataDialog";
import EditRolesDialog from "@/components/admin/pessoas/EditRolesDialog";

export default function PessoasTab({
  eventId, participants, sessions = [], hasAccess,
  onShowImport, showImport, onHideImport,
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState("all");
  const [filterPartner, setFilterPartner] = useState("all");
  const [page, setPage] = useState(1);

  const [addDialog, setAddDialog] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [editDataDialog, setEditDataDialog] = useState(null);
  const [editRolesDialog, setEditRolesDialog] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);

  // Load EventPartner + global Partners for partner name resolution
  const { data: eventPartners = [] } = useQuery({
    queryKey: ["event_partners", eventId],
    queryFn: () => base44.entities.EventPartner.filter({ event_id: eventId, is_deleted: false }),
  });
  // partner_rep participants in THIS event — only these need partner-name resolution.
  // Scoping avoids loading ALL reps/partners across every event in the platform.
  const partnerRepPersonIds = useMemo(
    () => participants.filter((p) => p.role_in_event === "partner_rep" && p.person_id).map((p) => p.person_id),
    [participants]
  );
  const hasPartnerReps = partnerRepPersonIds.length > 0;

  const { data: allPartners = [] } = useQuery({
    queryKey: ["global_partners_for_assoc"],
    queryFn: () => base44.entities.Partner.list("-created_date", 500),
    enabled: hasPartnerReps,
  });
  // Reps scoped to this event's partner_rep person_ids (not the entire platform)
  const { data: globalReps = [] } = useQuery({
    queryKey: ["event_partner_reps", eventId, partnerRepPersonIds],
    queryFn: () => base44.entities.PartnerRepresentative.filter({
      person_id: { $in: partnerRepPersonIds },
      is_deleted: false,
      is_active: true,
    }),
    enabled: hasPartnerReps,
  });
  // Avaliadores do evento (EventMembership role=reviewer) — para exibir chip + filtro
  const { data: reviewerMemberships = [] } = useQuery({
    queryKey: ["event-reviewers", eventId],
    queryFn: () => getEventReviewers(eventId),
  });
  const reviewerPersonIds = useMemo(() => new Set(reviewerMemberships.map((m) => m.person_id).filter(Boolean)), [reviewerMemberships]);

  const partnerMap = useMemo(() => Object.fromEntries(allPartners.map((p) => [p.id, p])), [allPartners]);
  const eventPartnerSet = useMemo(() => new Set(eventPartners.map((ep) => ep.partner_id)), [eventPartners]);

  // Build partner name for partner_rep participants
  // person_id → PartnerRepresentative → partner_id → EventPartner (must be in event) → Partner.trade_name
  const getPartnerName = useMemo(() => (participant) => {
    if (participant.role_in_event !== "partner_rep") return "";
    if (!participant.person_id) return "";
    const rep = globalReps.find((r) => r.person_id === participant.person_id);
    if (!rep) return "";
    if (!eventPartnerSet.has(rep.partner_id)) return "";
    return partnerMap[rep.partner_id]?.trade_name || "";
  }, [globalReps, eventPartnerSet, partnerMap]);

  const rows = useMemo(() => participants.map((p) => {
    const roles = [];
    if (reviewerPersonIds.has(p.person_id)) roles.push("reviewer");
    if (p.role_in_event && p.role_in_event !== "attendee") roles.push(p.role_in_event);
    if (roles.length === 0) roles.push("attendee");
    return { ...p, derivedRoles: roles, partnerName: getPartnerName(p) };

  }), [participants, getPartnerName, reviewerPersonIds]);

  // Unique partners in this event (for filter dropdown)
  const partnerNamesInEvent = useMemo(() => [...new Set(rows.map((r) => r.partnerName).filter(Boolean))], [rows]);

  const filtered = useMemo(() => rows.filter((p) => {
    const q = search.toLowerCase();
    const matchSearch = !search ||
      (p.full_name || "").toLowerCase().includes(q) ||
      (p.cpf || "").includes(q) ||
      (p.email || "").toLowerCase().includes(q);
    const matchRole = filterRole === "all" || p.derivedRoles.includes(filterRole);
    const matchPartner = filterPartner === "all" || p.partnerName === filterPartner;
    return matchSearch && matchRole && matchPartner;
  }), [rows, search, filterRole, filterPartner]);

  useEffect(() => { setPage(1); }, [search, filterRole, filterPartner, rows]);

  const PAGE_SIZE = 25;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["participants", eventId] });
    queryClient.invalidateQueries({ queryKey: ["my_participant_check", eventId] });
  };

  // ── Check-in toggle ──────────────────────────────────────────────────────────
  const handleToggleCheckin = async (pessoa) => {
    const isConfirmed = pessoa.checkin_status === "confirmed";
    const updates = isConfirmed
      ? { checkin_status: "pending", checkin_at: null, checked_in_by_user_id: null }
      : { checkin_status: "confirmed", checkin_at: new Date().toISOString(), checked_in_by_user_id: user?.id };
    try {
      await updateParticipant(eventId, pessoa.id, updates);
      logAudit({
        event_id: eventId,
        action: "status_change",
        entity_type: "Participant",
        entity_id: pessoa.id,
        user,
        details: { field: "checkin_status", old_value: pessoa.checkin_status, new_value: updates.checkin_status },
      });
      invalidate();
      toast.success(isConfirmed ? `Check-in removido para ${pessoa.full_name}` : `Check-in confirmado para ${pessoa.full_name}`);
    } catch {
      toast.error("Erro ao atualizar check-in.");
    }
  };

  // ── Check-in por QR (ingresso) ──────────────────────────────────────────────
  const handleTicketScan = async (code) => {
    setScannerOpen(false);
    try {
      const res = await checkinTicket(code);
      if (res.ok) toast.success(`${res.message} ${res.holder_name || ""}`.trim());
      else if (res.status === "used") toast.warning(`${res.message} ${res.holder_name || ""}`.trim());
      else toast.error(`${res.message} ${res.holder_name || ""}`.trim());
      invalidate();
    } catch (e) {
      toast.error(e.message || "Erro no check-in.");
    }
  };

  // ── Export CSV ──────────────────────────────────────────────────────────────
  const handleExportCsv = () => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const headers = ["nome", "cpf", "email", "telefone", "papeis", "parceiro", "status", "checkin", "data_cadastro"];
    const rowsCsv = filtered.map((p) => [
      p.full_name || "", p.cpf || "", p.email || "", p.phone || "",
      p.derivedRoles.join(";"), p.partnerName || "",
      p.registration_status || "",
      p.checkin_status === "confirmed" ? `confirmado${p.checkin_at ? " " + new Date(p.checkin_at).toLocaleString("pt-BR") : ""}` : "pendente",
      p.created_date ? new Date(p.created_date).toLocaleDateString("pt-BR") : "",
    ]);
    const csv = [headers, ...rowsCsv]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `pessoas_evento_${eventId}_${ts}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // ── Remove ──────────────────────────────────────────────────────────────────
  const handleRemove = async (pessoa) => {
    const hasSessions = sessions.some((s) => s.speaker_id === pessoa.id);
    if (hasSessions) {
      toast.error("Não é possível remover: existe sessão associada a esta pessoa.");
      setRemoveTarget(null);
      return;
    }
    await softDeleteParticipant(eventId, pessoa.id);
    await decParticipantCounter(eventId, pessoa?.created_date, pessoa?.role_in_event);
    logAudit({ event_id: eventId, action: "soft_delete", entity_type: "Participant", entity_id: pessoa.id, user,
      details: { field: "vínculo_evento", new_value: "removido" } });
    invalidate();
    setRemoveTarget(null);
    toast.success(t("events.deleteSuccess"));
  };

  if (showImport) {
    return <CsvImport eventId={eventId} existingParticipants={participants} onComplete={onHideImport} />;
  }

  return (
    <div className="space-y-3">
      <PessoasToolbar
        search={search}
        onSearchChange={setSearch}
        filterRole={filterRole}
        onFilterRoleChange={setFilterRole}
        filterPartner={filterPartner}
        onFilterPartnerChange={setFilterPartner}
        partnerNames={partnerNamesInEvent}
        hasAccess={hasAccess}
        onScan={() => setScannerOpen(true)}
        onExport={handleExportCsv}
        onImport={onShowImport}
        onAdd={() => setAddDialog(true)}
      />

      <PessoasTable
        rows={paginated}
        filteredCount={filtered.length}
        totalPages={totalPages}
        page={page}
        onPageChange={setPage}
        hasAccess={hasAccess}
        onToggleCheckin={handleToggleCheckin}
        onEditData={setEditDataDialog}
        onEditRoles={setEditRolesDialog}
        onRemove={setRemoveTarget}
      />

      {/* Dialogs */}
      {addDialog && (
        <AddPersonToEventDialog
          eventId={eventId}
          existingParticipants={participants}
          user={user}
          onClose={() => setAddDialog(false)}
          onSuccess={invalidate}
        />
      )}

      {editDataDialog && (
        <EditParticipantDataDialog
          participant={editDataDialog}
          eventId={eventId}
          user={user}
          onClose={() => setEditDataDialog(null)}
          onSuccess={invalidate}
        />
      )}

      {editRolesDialog && (
        <EditRolesDialog
          pessoa={editRolesDialog}
          eventId={eventId}
          sessions={sessions}
          user={user}
          onClose={() => setEditRolesDialog(null)}
          onSuccess={invalidate}
        />
      )}

      <QRScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={handleTicketScan}
        title="Check-in do Ingresso"
        codeLabel="Digite o código do ingresso:"
        codePlaceholder="Código do ingresso"
        hint="Aponte a câmera para o QR Code do ingresso."
        confirmLabel="Confirmar check-in"
      />

      <ConfirmDeleteDialog
        open={!!removeTarget}
        onOpenChange={() => setRemoveTarget(null)}
        title="Remover do evento?"
        description={`${removeTarget?.full_name || ""} será removido(a) deste evento. Os dados globais da pessoa não são apagados.`}
        confirmLabel="Remover"
        onConfirm={() => handleRemove(removeTarget)}
      />
    </div>
  );
}
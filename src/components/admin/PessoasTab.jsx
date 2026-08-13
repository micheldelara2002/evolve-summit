/**
 * Tela única "Pessoas do Evento"
 * Fluxo: busca Person global → associa ao evento (upsert Participant)
 *        ou cria nova Person e associa automaticamente.
 * - Chips de papéis, coluna parceiro, menu de contexto — mantidos.
 * - partner_rep NÃO é atribuído manualmente aqui (vem da tela de Partner).
 */
import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/AuthContext";
import { isAdmin } from "@/lib/access";
import { logAudit } from "@/lib/audit";
import { incParticipantCounter, decParticipantCounter } from "@/lib/businessCounters";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Pencil, Trash2, Search, UserCog, Upload, Download, MoreVertical, UserPlus, CheckCircle2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import CsvImport from "@/components/admin/CsvImport";
import PersonFormDialog from "@/components/admin/PersonFormDialog";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";

// ── Role display ──────────────────────────────────────────────────────────────
const ROLE_COLORS = {
  attendee:    "bg-slate-100 text-slate-700",
  speaker:     "bg-violet-100 text-violet-700",
  team:        "bg-emerald-100 text-emerald-700",
  manager:     "bg-amber-100 text-amber-700",
  partner_rep: "bg-sky-100 text-sky-700",
  reviewer:    "bg-cyan-100 text-cyan-700",
};

const ROLE_LABELS = {
  attendee:    "Participante",
  speaker:     "Palestrante",
  team:        "Equipe",
  manager:     "Gerente",
  partner_rep: "Representante",
  reviewer:    "Avaliador",
};

// ── Role rules ────────────────────────────────────────────────────────────────
// Only allowed accumulation: speaker + partner_rep.
// All others are mutually exclusive.
function getDisabledRoles(selected) {
  const disabled = new Set();
  if (selected.includes("manager"))     { disabled.add("team"); disabled.add("speaker"); }
  if (selected.includes("team"))        { disabled.add("manager"); disabled.add("speaker"); }
  if (selected.includes("speaker"))     { disabled.add("manager"); disabled.add("team"); }
  // attendee is always implicit, never in disabled
  return disabled;
}

// ── Build display row ─────────────────────────────────────────────────────────
function buildRow(participant, eventPartners, allPartners) {
  // Derive roles list for display
  const roles = [];
  if (participant.role_in_event && participant.role_in_event !== "attendee") {
    roles.push(participant.role_in_event);
  }
  if (roles.length === 0) roles.push("attendee");

  // Partner name from EventPartner → Partner lookup via person_id (best effort)
  // partner_rep participants have person_id; find EventPartner via... we don't have direct link here.
  // Use person_id to find PartnerRepresentative → partner_id → EventPartner → Partner name
  // For now: show partner from EventPartner list if participant is partner_rep
  let partnerName = "";
  // We'll resolve this in the component with a map passed in

  return { ...participant, derivedRoles: roles, partnerName };
}

// ── Main export ───────────────────────────────────────────────────────────────
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
    queryFn: () => base44.entities.EventMembership.filter({ event_id: eventId, role: "reviewer", is_active: true, is_deleted: false }),
  });
  const reviewerPersonIds = useMemo(() => new Set(reviewerMemberships.map((m) => m.person_id).filter(Boolean)), [reviewerMemberships]);

  const partnerMap = Object.fromEntries(allPartners.map((p) => [p.id, p]));
  const eventPartnerSet = new Set(eventPartners.map((ep) => ep.partner_id));

  // Build partner name for partner_rep participants
  // person_id → PartnerRepresentative → partner_id → EventPartner (must be in event) → Partner.trade_name
  function getPartnerName(participant) {
    if (participant.role_in_event !== "partner_rep") return "";
    if (!participant.person_id) return "";
    const rep = globalReps.find((r) => r.person_id === participant.person_id);
    if (!rep) return "";
    if (!eventPartnerSet.has(rep.partner_id)) return "";
    return partnerMap[rep.partner_id]?.trade_name || "";
  }

  const rows = useMemo(() => participants.map((p) => {
    const roles = [];
    if (reviewerPersonIds.has(p.person_id)) roles.push("reviewer");
    if (p.role_in_event && p.role_in_event !== "attendee") roles.push(p.role_in_event);
    if (roles.length === 0) roles.push("attendee");
    return { ...p, derivedRoles: roles, partnerName: getPartnerName(p) };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [participants, globalReps, eventPartners, allPartners, reviewerPersonIds]);

  // Unique partners in this event (for filter dropdown)
  const partnerNamesInEvent = [...new Set(rows.map((r) => r.partnerName).filter(Boolean))];

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
      await base44.entities.Participant.update(pessoa.id, updates);
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
    await base44.entities.Participant.update(pessoa.id, { is_deleted: true });
    await decParticipantCounter(eventId, pessoa?.created_date);
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
      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[160px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Nome, CPF ou e-mail..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9 h-9" />
        </div>
        <Select value={filterRole} onValueChange={setFilterRole}>
          <SelectTrigger className="h-9 w-36"><SelectValue placeholder="Papel" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos papéis</SelectItem>
            <SelectItem value="attendee">Participante</SelectItem>
            <SelectItem value="speaker">Palestrante</SelectItem>
            <SelectItem value="team">Equipe</SelectItem>
            <SelectItem value="manager">Gerente</SelectItem>
            <SelectItem value="reviewer">Avaliador</SelectItem>
            <SelectItem value="partner_rep">Representante</SelectItem>
          </SelectContent>
        </Select>
        {partnerNamesInEvent.length > 0 && (
          <Select value={filterPartner} onValueChange={setFilterPartner}>
            <SelectTrigger className="h-9 w-36"><SelectValue placeholder="Parceiro" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos parceiros</SelectItem>
              {partnerNamesInEvent.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <div className="flex gap-2 ml-auto">
          <Button variant="outline" size="sm" className="gap-1" onClick={handleExportCsv}>
            <Download className="w-4 h-4" /> Exportar
          </Button>
          {hasAccess && (
            <Button variant="outline" size="sm" className="gap-1" onClick={onShowImport}>
              <Upload className="w-4 h-4" /> CSV
            </Button>
          )}
          {hasAccess && (
            <Button size="sm" className="gap-1" onClick={() => setAddDialog(true)}>
              <UserPlus className="w-4 h-4" /> Adicionar pessoa
            </Button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/60 text-left">
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Nome</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden sm:table-cell">CPF</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden md:table-cell">E-mail</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden lg:table-cell">Telefone</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Papéis</th>
                <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground hidden md:table-cell">Parceiro</th>
                {hasAccess && <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-center">Check-in</th>}
                {hasAccess && <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-right">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {paginated.map((pessoa, idx) => (
                <tr key={pessoa.id} className={`border-t border-border ${idx % 2 === 0 ? "bg-card" : "bg-muted/20"} hover:bg-muted/40 transition-colors`}>
                  <td className="px-3 py-2.5 text-sm font-medium">{pessoa.full_name}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden sm:table-cell font-mono">{pessoa.cpf || "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell max-w-[160px] truncate">{pessoa.email}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">{pessoa.phone || "—"}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {pessoa.derivedRoles.map((role) => (
                        <span key={role} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_COLORS[role] || "bg-muted text-muted-foreground"}`}>
                          {ROLE_LABELS[role] || role}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell">{pessoa.partnerName || "—"}</td>
                  {hasAccess && (
                    <td className="px-3 py-2.5 text-center">
                      <TooltipProvider delayDuration={300}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="inline-flex items-center justify-center">
                              <Switch
                                checked={pessoa.checkin_status === "confirmed"}
                                onCheckedChange={() => handleToggleCheckin(pessoa)}
                              />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            {pessoa.checkin_status === "confirmed"
                              ? `Confirmado em ${pessoa.checkin_at ? new Date(pessoa.checkin_at).toLocaleString("pt-BR") : ""} — clique para desfazer`
                              : "Pendente — clique para confirmar check-in"}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </td>
                  )}
                  {hasAccess && (
                    <td className="px-3 py-2.5 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditDataDialog(pessoa)}>
                            <Pencil className="w-4 h-4 mr-2" /> Editar dados
                          </DropdownMenuItem>
                          {pessoa.role_in_event !== "partner_rep" && (
                            <DropdownMenuItem onClick={() => setEditRolesDialog(pessoa)}>
                              <UserCog className="w-4 h-4 mr-2" /> Editar papéis
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem className="text-destructive" onClick={() => setRemoveTarget(pessoa)}>
                            <Trash2 className="w-4 h-4 mr-2" /> Remover do evento
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <p className="text-center text-muted-foreground py-8 text-sm">{t("common.noData")}</p>
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{filtered.length} pessoa(s)</span>
        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
            <span className="px-2">pág. {page}/{totalPages}</span>
            <Button size="sm" variant="outline" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>Próxima</Button>
          </div>
        )}
      </div>

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

// ── Add person to event ───────────────────────────────────────────────────────
// Step 1: search existing Person
// Step 2a: associate found person
// Step 2b: create new Person (via PersonFormDialog) then associate
function AddPersonToEventDialog({ eventId, existingParticipants, user, onClose, onSuccess }) {
  const [step, setStep] = useState("search"); // "search" | "create" | "confirm_dup"
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState(null); // null = not searched yet
  const [searching, setSearching] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [associating, setAssociating] = useState(false);
  const [dupCandidate, setDupCandidate] = useState(null); // potential duplicate to confirm

  const alreadyInEvent = new Set(
    existingParticipants.filter((p) => p.person_id).map((p) => p.person_id)
  );
  const alreadyByEmail = new Set(
    existingParticipants.map((p) => p.email).filter(Boolean)
  );

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    const q = searchQ.trim().toLowerCase();
    // Search Person global
    const all = await base44.entities.Person.list("-full_name", 500);
    const results = all.filter(
      (p) =>
        p.full_name?.toLowerCase().includes(q) ||
        p.contact_email?.toLowerCase().includes(q)
    );
    // Document search: only if query has digits, scoped to persons already loaded
    let extra = [];
    const digits = q.replace(/\D/g, "");
    if (digits.length >= 3) {
      const docs = await base44.entities.PersonDocument.filter({
        person_id: { $in: all.map((p) => p.id) },
      });
      const docPersonIds = new Set(
        docs
          .filter((d) => d.document_number?.replace(/\D/g, "").includes(digits))
          .map((d) => d.person_id)
      );
      extra = all.filter((p) => docPersonIds.has(p.id) && !results.find((r) => r.id === p.id));
    }
    setSearchResults([...results, ...extra]);
    setSearching(false);
  };

  const associatePerson = async (person) => {
    // Check if already in event
    if (alreadyInEvent.has(person.id)) {
      toast.error("Esta pessoa já está associada a este evento.");
      return;
    }
    if (alreadyByEmail.has(person.contact_email) && person.contact_email) {
      toast.error("Já existe um participante com este e-mail neste evento.");
      return;
    }
    setAssociating(true);
    const created = await base44.entities.Participant.create({
      event_id: eventId,
      full_name: person.full_name,
      email: person.contact_email || "",
      phone: person.phone || "",
      company: person.company || "",
      job_title: person.job_title || "",
      bio: person.bio || "",
      linkedin: person.linkedin || "",
      person_id: person.id,
      role_in_event: "attendee",
      registration_status: "registered",
      is_deleted: false,
    });
    await incParticipantCounter(eventId, created?.created_date);
    logAudit({ event_id: eventId, action: "create", entity_type: "Participant", entity_id: person.id, user,
      details: { field: "vínculo_evento", new_value: "associado" } });
    setAssociating(false);
    onSuccess();
    onClose();
    toast.success("Pessoa associada ao evento.");
  };

  const handlePersonCreated = async (newPerson) => {
    // After creating Person, associate immediately
    await associatePerson(newPerson);
  };

  if (step === "create") {
    return (
      <PersonFormDialog
        person={null}
        onClose={() => setStep("search")}
        onSaved={handlePersonCreated}
      />
    );
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adicionar pessoa ao evento</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <p className="text-xs text-muted-foreground">
            Busque uma pessoa já cadastrada no sistema ou crie uma nova.
          </p>

          {/* Search box */}
          <div className="flex gap-2">
            <Input
              placeholder="Nome, e-mail ou documento..."
              value={searchQ}
              onChange={(e) => { setSearchQ(e.target.value); setSearchResults(null); }}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="flex-1"
            />
            <Button type="button" variant="outline" onClick={handleSearch} disabled={searching || !searchQ.trim()}>
              {searching ? "..." : <Search className="w-4 h-4" />}
            </Button>
          </div>

          {/* Results */}
          {searchResults !== null && (
            <div className="space-y-1 max-h-56 overflow-y-auto">
              {searchResults.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-3">
                  Nenhuma pessoa encontrada.
                </p>
              ) : (
                searchResults.map((p) => {
                  const inEvent = alreadyInEvent.has(p.id) || (p.contact_email && alreadyByEmail.has(p.contact_email));
                  return (
                    <div
                      key={p.id}
                      className={`flex items-center justify-between px-3 py-2 rounded-lg border transition-colors ${inEvent ? "opacity-50 border-border" : "border-border hover:bg-muted/40 cursor-pointer"}`}
                      onClick={() => !inEvent && associatePerson(p)}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{p.full_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{p.contact_email || "sem e-mail"}</p>
                      </div>
                      {inEvent ? (
                        <span className="text-xs text-muted-foreground shrink-0 ml-2">Já no evento</span>
                      ) : (
                        <Button size="sm" variant="outline" className="shrink-0 ml-2" disabled={associating} onClick={(e) => { e.stopPropagation(); associatePerson(p); }}>
                          Associar
                        </Button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button variant="outline" onClick={onClose} className="flex-1">Cancelar</Button>
          <Button variant="outline" className="flex-1 gap-1" onClick={() => setStep("create")}>
            <Plus className="w-4 h-4" /> Criar nova pessoa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit participant data (updates Participant record + optionally syncs Person) ──
function EditParticipantDataDialog({ participant, eventId, user, onClose, onSuccess }) {
  const [form, setForm] = useState({
    full_name: participant.full_name || "",
    email: participant.email || "",
    cpf: participant.cpf || "",
    phone: participant.phone || "",
    company: participant.company || "",
    job_title: participant.job_title || "",
    linkedin: participant.linkedin || "",
    instagram: participant.instagram || "",
    youtube: participant.youtube || "",
    website: participant.website || "",
    bio: participant.bio || "",
  });
  const [saving, setSaving] = useState(false);
  const update = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await base44.entities.Participant.update(participant.id, { ...form, cpf: form.cpf.replace(/\D/g, "") });
    // If linked to a Person, sync name/email/phone to Person global
    if (participant.person_id) {
      await base44.entities.Person.update(participant.person_id, {
        full_name: form.full_name,
        contact_email: form.email,
        phone: form.phone,
        company: form.company,
        job_title: form.job_title,
        bio: form.bio,
        linkedin: form.linkedin,
      });
    }
    logAudit({ event_id: eventId, action: "update", entity_type: "Participant", entity_id: participant.id, user });
    setSaving(false);
    onSuccess();
    onClose();
    toast.success(t("events.saveSuccess"));
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="font-display">Editar dados — {participant.full_name}</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1"><Label>Nome *</Label><Input value={form.full_name} onChange={(e) => update("full_name", e.target.value)} required /></div>
            <div className="col-span-2 space-y-1"><Label>E-mail</Label><Input type="email" value={form.email} onChange={(e) => update("email", e.target.value)} /></div>
            <div className="space-y-1"><Label>CPF</Label><Input value={form.cpf} onChange={(e) => update("cpf", e.target.value)} /></div>
            <div className="space-y-1"><Label>Telefone</Label><Input value={form.phone} onChange={(e) => update("phone", e.target.value)} /></div>
            <div className="space-y-1"><Label>Empresa</Label><Input value={form.company} onChange={(e) => update("company", e.target.value)} /></div>
            <div className="space-y-1"><Label>Cargo</Label><Input value={form.job_title} onChange={(e) => update("job_title", e.target.value)} /></div>
            <div className="space-y-1"><Label>LinkedIn</Label><Input value={form.linkedin} onChange={(e) => update("linkedin", e.target.value)} /></div>
            <div className="space-y-1"><Label>Instagram</Label><Input value={form.instagram} onChange={(e) => update("instagram", e.target.value)} /></div>
            <div className="space-y-1"><Label>Youtube</Label><Input value={form.youtube} onChange={(e) => update("youtube", e.target.value)} /></div>
            <div className="space-y-1"><Label>Site</Label><Input value={form.website} onChange={(e) => update("website", e.target.value)} /></div>
            <div className="col-span-2 space-y-1"><Label>Sobre mim</Label><Textarea value={form.bio} onChange={(e) => update("bio", e.target.value)} rows={2} /></div>
          </div>
          {participant.person_id && (
            <p className="text-xs text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
              Esta pessoa está vinculada a um cadastro global. As alterações serão sincronizadas automaticamente.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={saving}>{saving ? t("common.loading") : t("common.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit roles dialog ─────────────────────────────────────────────────────────
// partner_rep is NOT assignable here; shown as read-only chip if present.
function EditRolesDialog({ pessoa, eventId, sessions = [], user, onClose, onSuccess }) {
  const isPartnerRep = pessoa.role_in_event === "partner_rep";

  const [roles, setRoles] = useState(() => {
    if (isPartnerRep) return []; // managed elsewhere
    const r = [];
    if (["speaker", "team", "manager"].includes(pessoa.role_in_event)) r.push(pessoa.role_in_event);
    return r;
  });
  const [isReviewer, setIsReviewer] = useState(false);
  const [reviewerMembership, setReviewerMembership] = useState(null);
  const [reviewerUserId, setReviewerUserId] = useState("");
  const [checkingReviewer, setCheckingReviewer] = useState(!isPartnerRep && !!pessoa.person_id);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const queryClient = useQueryClient();

  const disabledRoles = useMemo(() => getDisabledRoles(roles), [roles]);

  // Resolve existing reviewer membership + linked user_id (by email)
  useEffect(() => {
    if (isPartnerRep || !pessoa.person_id) { setCheckingReviewer(false); return; }
    (async () => {
      try {
        const m = await base44.entities.EventMembership.filter({
          event_id: eventId, person_id: pessoa.person_id, role: "reviewer", is_deleted: false,
        });
        if (m[0]) { setReviewerMembership(m[0]); setIsReviewer(true); }
        if (pessoa.email) {
          const u = await base44.entities.User.filter({ email: pessoa.email });
          if (u[0]) setReviewerUserId(u[0].id);
        }
      } finally { setCheckingReviewer(false); }
    })();
  }, [isPartnerRep, pessoa.person_id, pessoa.email, eventId]);

  const toggleRole = (role) => {
    setConflict(null);
    if (role === "reviewer") { setIsReviewer((v) => !v); return; }
    if (roles.includes(role)) {
      setRoles((prev) => prev.filter((r) => r !== role));
    } else if (!disabledRoles.has(role)) {
      setRoles((prev) => [...prev, role]);
    }
  };

  const handleSave = async () => {
    // Block remove speaker if person has sessions
    if (pessoa.role_in_event === "speaker" && !roles.includes("speaker")) {
      const hasSessions = sessions.some((s) => s.speaker_id === pessoa.id);
      if (hasSessions) {
        setConflict("Não é possível alterar o papel: esta pessoa possui sessão associada. Edite a sessão primeiro.");
        return;
      }
    }

    setSaving(true);
    try {
      // Papel no Participant (speaker/team/manager/attendee)
      let newRole = "attendee";
      if (roles.includes("manager")) newRole = "manager";
      else if (roles.includes("speaker")) newRole = "speaker";
      else if (roles.includes("team")) newRole = "team";
      if (newRole !== pessoa.role_in_event) {
        await base44.entities.Participant.update(pessoa.id, { role_in_event: newRole });
        logAudit({ event_id: eventId, action: "role_change", entity_type: "Participant", entity_id: pessoa.id, user,
          details: { field: "role_in_event", old_value: pessoa.role_in_event, new_value: newRole } });
      }

      // Avaliador — gerenciado via EventMembership (independente do role_in_event)
      if (!pessoa.person_id && isReviewer) {
        setConflict("Esta pessoa não tem perfil global (Person) vinculado; não é possível designá-la como avaliadora.");
        setSaving(false);
        return;
      }
      if (isReviewer && !reviewerMembership) {
        await base44.entities.EventMembership.create({
          event_id: eventId,
          person_id: pessoa.person_id,
          person_name: pessoa.full_name,
          user_id: reviewerUserId || "",
          user_email: pessoa.email || "",
          role: "reviewer",
          is_active: true,
        });
      } else if (!isReviewer && reviewerMembership) {
        await base44.entities.EventMembership.update(reviewerMembership.id, { is_deleted: true });
      }

      queryClient.invalidateQueries({ queryKey: ["event-reviewers", eventId] });
      onSuccess();
      onClose();
      toast.success(t("events.saveSuccess"));
    } finally {
      setSaving(false);
    }
  };

  const ROLE_OPTIONS = [
    { value: "speaker",  label: "Palestrante" },
    { value: "team",     label: "Equipe" },
    { value: "manager",  label: "Gerente" },
    { value: "reviewer", label: "Avaliador" },
  ];

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="font-display">Papéis — {pessoa.full_name}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          {isPartnerRep ? (
            <div className="text-sm text-muted-foreground bg-sky-50 rounded-lg px-3 py-2">
              Esta pessoa é Representante de Parceiro. O papel é gerenciado na aba <strong>Parceiros</strong>.
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Participante é implícito. Selecione papéis adicionais:</p>
              <div className="grid grid-cols-2 gap-2">
                {ROLE_OPTIONS.map(({ value, label }) => {
                  const active = value === "reviewer" ? isReviewer : roles.includes(value);
                  const disabled = value === "reviewer" ? false : disabledRoles.has(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => toggleRole(value)}
                      disabled={disabled}
                      className={`rounded-xl border p-3 text-sm font-medium transition-colors text-center
                        ${active ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground"}
                        ${disabled ? "opacity-35 cursor-not-allowed" : "hover:bg-muted/40"}`}
                    >
                      {label}{active && " ✓"}
                    </button>
                  );
                })}
              </div>
              {checkingReviewer && <p className="text-xs text-muted-foreground">Verificando status de avaliador…</p>}
              {isReviewer && !reviewerUserId && !checkingReviewer && (
                <p className="text-xs text-warning bg-warning/10 rounded-lg px-3 py-2">
                  Esta pessoa não tem conta de acesso (User) com este e-mail. Convide-a para que consiga acessar o painel de avaliação.
                </p>
              )}
            </>
          )}
          {conflict && <p className="text-sm text-destructive bg-red-50 rounded-lg px-3 py-2">{conflict}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          {!isPartnerRep && (
            <Button onClick={handleSave} disabled={saving}>{saving ? t("common.loading") : t("common.save")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
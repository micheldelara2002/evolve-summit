/**
 * Tela única "Pessoas do Evento"
 * - Tabela com chips de papéis
 * - Filtros por nome/CPF/email, papel e parceiro
 * - Ações: editar dados, editar papéis, remover do evento
 * - Cadastro com CPF reuse
 * - Modal "Editar papéis" com regras de combinação
 */
import { useState, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/AuthContext";
import { isAdmin } from "@/lib/access";
import { logAudit } from "@/lib/audit";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter as ADF, AlertDialogHeader, AlertDialogTitle as ADT } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Pencil, Trash2, Search, UserCog, Upload } from "lucide-react";
import { toast } from "sonner";
import CsvImport from "@/components/admin/CsvImport";

// ── Papel chips ───────────────────────────────────────────────────────────────
const ROLE_COLORS = {
  attendee: "bg-slate-100 text-slate-700",
  speaker:  "bg-violet-100 text-violet-700",
  team:     "bg-emerald-100 text-emerald-700",
  manager:  "bg-amber-100 text-amber-700",
  rep:      "bg-sky-100 text-sky-700",
};

// Regras de combinação de papéis (conflitos)
const ROLE_CONFLICTS = [
  { roles: ["manager", "team"],       msg: "Gerente não pode acumular com Equipe." },
  { roles: ["team", "speaker"],       msg: "Equipe não pode acumular com Palestrante." },
  { roles: ["team", "rep"],           msg: "Equipe não pode acumular com Representante." },
];

function validateRoles(roles) {
  for (const rule of ROLE_CONFLICTS) {
    if (rule.roles.every((r) => roles.includes(r))) return rule.msg;
  }
  return null;
}

// Pessoa tem papel "rep" se há algum PartnerRepresentative com o mesmo CPF/email neste evento
function buildPessoaRow(p, reps, partners) {
  const isRep = reps.some((r) => r.email === p.email || (p.cpf && r.full_name === p.full_name));
  const repRecord = isRep ? reps.find((r) => r.email === p.email || r.full_name === p.full_name) : null;
  const partnerName = repRecord ? (partners.find((pt) => pt.id === repRecord.partner_id)?.name || "") : "";

  const roles = [];
  if (p.role_in_event && p.role_in_event !== "attendee") roles.push(p.role_in_event);
  if (isRep) roles.push("rep");
  if (roles.length === 0) roles.push("attendee");

  return { ...p, derivedRoles: roles, partnerName, repRecord };
}

export default function PessoasTab({ eventId, participants, reps, partners, hasAccess, onShowImport, showImport, onHideImport }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const adminUser = isAdmin(user);

  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState("all");
  const [filterPartner, setFilterPartner] = useState("all");

  // Dialogs
  const [addDialog, setAddDialog] = useState(false);
  const [editDataDialog, setEditDataDialog] = useState(null); // pessoa
  const [editRolesDialog, setEditRolesDialog] = useState(null); // pessoa
  const [removeTarget, setRemoveTarget] = useState(null);

  // Quick partner create (within editRoles flow)
  const [quickPartnerDialog, setQuickPartnerDialog] = useState(false);
  const [pendingRolesContext, setPendingRolesContext] = useState(null); // preserve context

  const rows = useMemo(() => participants.map((p) => buildPessoaRow(p, reps, partners)), [participants, reps, partners]);

  const filtered = useMemo(() => {
    return rows.filter((p) => {
      const q = search.toLowerCase();
      const matchSearch = !search ||
        (p.full_name || "").toLowerCase().includes(q) ||
        (p.cpf || "").includes(q) ||
        (p.email || "").toLowerCase().includes(q);
      const matchRole = filterRole === "all" || p.derivedRoles.includes(filterRole);
      const matchPartner = filterPartner === "all" || p.partnerName === filterPartner;
      return matchSearch && matchRole && matchPartner;
    });
  }, [rows, search, filterRole, filterPartner]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["participants", eventId] });
    queryClient.invalidateQueries({ queryKey: ["reps", eventId] });
    queryClient.invalidateQueries({ queryKey: ["partners", eventId] });
  };

  // ── Remove from event (soft delete) ──────────────────────────────────────
  const handleRemove = async (pessoa) => {
    await base44.entities.Participant.update(pessoa.id, { is_deleted: true });
    // Also soft-delete rep record if exists
    if (pessoa.repRecord) {
      await base44.entities.PartnerRepresentative.update(pessoa.repRecord.id, { is_deleted: true });
    }
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
            <SelectItem value="rep">Representante</SelectItem>
          </SelectContent>
        </Select>
        {partners.length > 0 && (
          <Select value={filterPartner} onValueChange={setFilterPartner}>
            <SelectTrigger className="h-9 w-36"><SelectValue placeholder="Parceiro" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos parceiros</SelectItem>
              {partners.map((p) => <SelectItem key={p.id} value={p.name}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <div className="flex gap-2 ml-auto">
          {hasAccess && (
            <Button variant="outline" size="sm" className="gap-1" onClick={onShowImport}>
              <Upload className="w-4 h-4" /> CSV
            </Button>
          )}
          {hasAccess && (
            <Button size="sm" className="gap-1" onClick={() => setAddDialog(true)}>
              <Plus className="w-4 h-4" /> Adicionar pessoa
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
                {hasAccess && <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-right">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((pessoa, idx) => (
                <tr key={pessoa.id} className={`border-t border-border ${idx % 2 === 0 ? "bg-card" : "bg-muted/20"} hover:bg-muted/40 transition-colors`}>
                  <td className="px-3 py-2.5 text-sm font-medium">{pessoa.full_name}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden sm:table-cell font-mono">{pessoa.cpf || "—"}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell max-w-[160px] truncate">{pessoa.email}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">{pessoa.phone || "—"}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {pessoa.derivedRoles.map((role) => (
                        <span key={role} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_COLORS[role] || "bg-muted text-muted-foreground"}`}>
                          {role === "rep" ? "Representante" : t(`roles.${role}`) || role}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground hidden md:table-cell">{pessoa.partnerName || "—"}</td>
                  {hasAccess && (
                    <td className="px-3 py-2.5">
                      <div className="flex gap-1 justify-end">
                        <Button variant="ghost" size="icon" className="h-7 w-7" title="Editar dados" onClick={() => setEditDataDialog(pessoa)}>
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7" title="Editar papéis" onClick={() => setEditRolesDialog(pessoa)}>
                          <UserCog className="w-3.5 h-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" title="Remover do evento" onClick={() => setRemoveTarget(pessoa)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
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
      <p className="text-xs text-muted-foreground">{filtered.length} pessoa(s)</p>

      {/* Add person dialog */}
      {addDialog && (
        <AddPersonDialog
          eventId={eventId}
          user={user}
          onClose={() => setAddDialog(false)}
          onSuccess={invalidate}
        />
      )}

      {/* Edit data dialog */}
      {editDataDialog && (
        <EditDataDialog
          pessoa={editDataDialog}
          user={user}
          eventId={eventId}
          onClose={() => setEditDataDialog(null)}
          onSuccess={invalidate}
        />
      )}

      {/* Edit roles dialog */}
      {editRolesDialog && (
        <EditRolesDialog
          pessoa={editRolesDialog}
          eventId={eventId}
          partners={partners}
          reps={reps}
          user={user}
          onClose={() => setEditRolesDialog(null)}
          onSuccess={invalidate}
          onNeedPartner={(ctx) => { setPendingRolesContext(ctx); setEditRolesDialog(null); setQuickPartnerDialog(true); }}
        />
      )}

      {/* Quick partner create */}
      {quickPartnerDialog && (
        <QuickPartnerDialog
          eventId={eventId}
          user={user}
          onClose={() => { setQuickPartnerDialog(false); if (pendingRolesContext) setEditRolesDialog(pendingRolesContext); }}
          onSuccess={() => {
            invalidate();
            setQuickPartnerDialog(false);
            if (pendingRolesContext) setEditRolesDialog(pendingRolesContext);
          }}
        />
      )}

      {/* Remove confirm */}
      <AlertDialog open={!!removeTarget} onOpenChange={() => setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <ADT>Remover do evento?</ADT>
            <AlertDialogDescription>
              {removeTarget?.full_name} será removido(a) deste evento (soft delete). Os dados globais da pessoa não são apagados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ADF>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground" onClick={() => handleRemove(removeTarget)}>
              Remover
            </AlertDialogAction>
          </ADF>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Add person dialog ────────────────────────────────────────────────────────
function AddPersonDialog({ eventId, user, onClose, onSuccess }) {
  const [form, setForm] = useState({ full_name: "", email: "", cpf: "", phone: "", company: "", job_title: "", linkedin: "", instagram: "", youtube: "", website: "", bio: "" });
  const [saving, setSaving] = useState(false);
  const [reuseData, setReuseData] = useState(null); // { existingPerson }

  const update = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const cpfNorm = form.cpf.replace(/\D/g, "");
    if (!cpfNorm) { toast.error("CPF é obrigatório."); setSaving(false); return; }
    // Check global base — ALL records with this CPF (any event)
    const existing = await base44.entities.Participant.filter({ cpf: cpfNorm, is_deleted: false });
    // Already linked to this event?
    const alreadyInEvent = existing.some((p) => p.event_id === eventId);
    if (alreadyInEvent) { toast.error("CPF já cadastrado neste evento."); setSaving(false); return; }
    // Exists in another event → offer link
    const notInEvent = existing.filter((p) => p.event_id !== eventId);
    if (notInEvent.length > 0) {
      setReuseData({ existingPerson: notInEvent[0] });
      setSaving(false);
      return;
    }
    await base44.entities.Participant.create({ ...form, cpf: cpfNorm, event_id: eventId, role_in_event: "attendee", registration_status: "registered", is_deleted: false });
    logAudit({ event_id: eventId, action: "create", entity_type: "Participant", entity_id: cpfNorm, user, details: { field: "vínculo_evento", new_value: "criado" } });
    setSaving(false);
    onSuccess();
    onClose();
    toast.success(t("events.saveSuccess"));
  };

  const handleLink = async (existingPerson) => {
    await base44.entities.Participant.create({
      event_id: eventId, full_name: existingPerson.full_name, email: existingPerson.email, cpf: existingPerson.cpf,
      phone: existingPerson.phone || "", company: existingPerson.company || "", job_title: existingPerson.job_title || "",
      linkedin: existingPerson.linkedin || "", instagram: existingPerson.instagram || "", youtube: existingPerson.youtube || "",
      website: existingPerson.website || "", bio: existingPerson.bio || "",
      role_in_event: "attendee", registration_status: "registered", is_deleted: false,
    });
    logAudit({ event_id: eventId, action: "create", entity_type: "Participant", entity_id: existingPerson.id, user, details: { field: "vínculo_evento", new_value: "vinculado" } });
    setReuseData(null);
    onSuccess();
    onClose();
    toast.success("Participante vinculado ao evento com sucesso.");
  };

  if (reuseData) {
    return (
      <Dialog open onOpenChange={onClose}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="font-display">Pessoa já existe na base</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Este CPF já está cadastrado:</p>
            <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm">
              <p className="font-medium">{reuseData.existingPerson.full_name}</p>
              <p className="text-xs text-muted-foreground">{reuseData.existingPerson.email}</p>
              <p className="text-xs text-muted-foreground font-mono">CPF: {reuseData.existingPerson.cpf}</p>
            </div>
            <p className="text-sm">Deseja vinculá-la a este evento?</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
            <Button onClick={() => handleLink(reuseData.existingPerson)}>Vincular ao evento</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="font-display">Adicionar pessoa</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1"><Label>Nome *</Label><Input value={form.full_name} onChange={(e) => update("full_name", e.target.value)} required /></div>
            <div className="col-span-2 space-y-1"><Label>E-mail *</Label><Input type="email" value={form.email} onChange={(e) => update("email", e.target.value)} required /></div>
            <div className="space-y-1"><Label>CPF *</Label><Input value={form.cpf} onChange={(e) => update("cpf", e.target.value)} required /></div>
            <div className="space-y-1"><Label>Telefone *</Label><Input value={form.phone} onChange={(e) => update("phone", e.target.value)} required /></div>
            <div className="space-y-1"><Label>Empresa</Label><Input value={form.company} onChange={(e) => update("company", e.target.value)} /></div>
            <div className="space-y-1"><Label>Cargo</Label><Input value={form.job_title} onChange={(e) => update("job_title", e.target.value)} /></div>
            <div className="space-y-1"><Label>LinkedIn</Label><Input value={form.linkedin} onChange={(e) => update("linkedin", e.target.value)} /></div>
            <div className="space-y-1"><Label>Instagram</Label><Input value={form.instagram} onChange={(e) => update("instagram", e.target.value)} /></div>
            <div className="space-y-1"><Label>Youtube</Label><Input value={form.youtube} onChange={(e) => update("youtube", e.target.value)} /></div>
            <div className="space-y-1"><Label>Site</Label><Input value={form.website} onChange={(e) => update("website", e.target.value)} /></div>
            <div className="col-span-2 space-y-1"><Label>Sobre mim</Label><Textarea value={form.bio} onChange={(e) => update("bio", e.target.value)} rows={2} /></div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={saving}>{saving ? t("common.loading") : "Adicionar"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit data dialog ──────────────────────────────────────────────────────────
function EditDataDialog({ pessoa, user, eventId, onClose, onSuccess }) {
  const [form, setForm] = useState({
    full_name: pessoa.full_name || "", email: pessoa.email || "", cpf: pessoa.cpf || "",
    phone: pessoa.phone || "", company: pessoa.company || "", job_title: pessoa.job_title || "",
    linkedin: pessoa.linkedin || "", instagram: pessoa.instagram || "", youtube: pessoa.youtube || "",
    website: pessoa.website || "", bio: pessoa.bio || "",
  });
  const [saving, setSaving] = useState(false);
  const update = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const old = { full_name: pessoa.full_name, email: pessoa.email };
    await base44.entities.Participant.update(pessoa.id, { ...form, cpf: form.cpf.replace(/\D/g, "") });
    logAudit({ event_id: eventId, action: "update", entity_type: "Participant", entity_id: pessoa.id, user,
      details: { field: "dados_globais", old_value: JSON.stringify(old), new_value: JSON.stringify({ full_name: form.full_name, email: form.email }) } });
    setSaving(false);
    onSuccess();
    onClose();
    toast.success(t("events.saveSuccess"));
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="font-display">Editar dados — {pessoa.full_name}</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1"><Label>Nome *</Label><Input value={form.full_name} onChange={(e) => update("full_name", e.target.value)} required /></div>
            <div className="col-span-2 space-y-1"><Label>E-mail *</Label><Input type="email" value={form.email} onChange={(e) => update("email", e.target.value)} required /></div>
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
function EditRolesDialog({ pessoa, eventId, partners, reps, user, onClose, onSuccess, onNeedPartner }) {
  const existingRep = reps.find((r) => r.email === pessoa.email || r.full_name === pessoa.full_name);

  const [roles, setRoles] = useState(() => {
    const r = [];
    if (pessoa.role_in_event === "speaker") r.push("speaker");
    if (pessoa.role_in_event === "team") r.push("team");
    if (pessoa.role_in_event === "manager") r.push("manager");
    if (existingRep) r.push("rep");
    return r;
  });
  const [partnerId, setPartnerId] = useState(existingRep?.partner_id || "");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);

  // Compute which roles should be disabled based on current selection
  const disabledRoles = useMemo(() => {
    const disabled = new Set();
    if (roles.includes("manager")) {
      disabled.add("team"); disabled.add("speaker"); disabled.add("rep");
    }
    if (roles.includes("team")) {
      disabled.add("manager"); disabled.add("speaker"); disabled.add("rep");
    }
    if (roles.includes("speaker")) {
      disabled.add("manager"); disabled.add("team");
    }
    if (roles.includes("rep")) {
      disabled.add("manager"); disabled.add("team");
    }
    return disabled;
  }, [roles]);

  const toggleRole = (role) => {
    if (roles.includes(role)) {
      setRoles((prev) => prev.filter((r) => r !== role));
    } else {
      if (!disabledRoles.has(role)) {
        setRoles((prev) => [...prev, role]);
      }
    }
    setConflict(null);
  };

  const handleSave = async () => {
    if (roles.includes("rep")) {
      if (!partnerId) { setConflict("Selecione um parceiro para o papel de Representante."); return; }
    }

    setSaving(true);
    const oldRole = pessoa.role_in_event;

    // Determine new role_in_event (non-rep roles; priority: manager > speaker > team > attendee)
    let newRole = "attendee";
    if (roles.includes("manager")) newRole = "manager";
    else if (roles.includes("speaker")) newRole = "speaker";
    else if (roles.includes("team")) newRole = "team";

    await base44.entities.Participant.update(pessoa.id, { role_in_event: newRole });
    logAudit({ event_id: eventId, action: "role_change", entity_type: "Participant", entity_id: pessoa.id, user,
      details: { field: "role_in_event", old_value: oldRole, new_value: newRole } });

    // Manage rep record
    if (roles.includes("rep") && !existingRep) {
      // Create rep record
      const rep = await base44.entities.PartnerRepresentative.create({
        event_id: eventId, partner_id: partnerId,
        full_name: pessoa.full_name, email: pessoa.email, phone: pessoa.phone || "", is_deleted: false,
      });
      logAudit({ event_id: eventId, action: "create", entity_type: "PartnerRepresentative", entity_id: rep.id, user,
        details: { field: "partner_id", new_value: partnerId } });
    } else if (roles.includes("rep") && existingRep && existingRep.partner_id !== partnerId) {
      await base44.entities.PartnerRepresentative.update(existingRep.id, { partner_id: partnerId });
      logAudit({ event_id: eventId, action: "update", entity_type: "PartnerRepresentative", entity_id: existingRep.id, user,
        details: { field: "partner_id", old_value: existingRep.partner_id, new_value: partnerId } });
    } else if (!roles.includes("rep") && existingRep) {
      // Soft delete rep record
      await base44.entities.PartnerRepresentative.update(existingRep.id, { is_deleted: true });
      logAudit({ event_id: eventId, action: "soft_delete", entity_type: "PartnerRepresentative", entity_id: existingRep.id, user,
        details: { field: "rep_vínculo", new_value: "removido" } });
    }

    setSaving(false);
    onSuccess();
    onClose();
    toast.success(t("events.saveSuccess"));
  };

  const ROLE_OPTIONS = [
    { value: "speaker", label: "Palestrante" },
    { value: "team", label: "Equipe" },
    { value: "manager", label: "Gerente" },
    { value: "rep", label: "Representante" },
  ];

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="font-display">Papéis — {pessoa.full_name}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">Participante é implícito. Selecione papéis adicionais:</p>
          <div className="grid grid-cols-2 gap-2">
            {ROLE_OPTIONS.map(({ value, label }) => {
              const active = roles.includes(value);
              const disabled = disabledRoles.has(value);
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => toggleRole(value)}
                  disabled={disabled}
                  className={`rounded-xl border p-3 text-sm font-medium transition-colors text-left
                    ${active ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground"}
                    ${disabled ? "opacity-35 cursor-not-allowed" : "hover:bg-muted/40"}`}
                >
                  {label}
                  {active && <span className="ml-1 text-xs">✓</span>}
                </button>
              );
            })}
          </div>

          {roles.includes("rep") && (
            <div className="space-y-2">
              <Label>Parceiro *</Label>
              {partners.length > 0 && (
                <Select value={partnerId} onValueChange={setPartnerId}>
                  <SelectTrigger><SelectValue placeholder="Selecionar parceiro" /></SelectTrigger>
                  <SelectContent>
                    {partners.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              {partners.length === 0 && (
                <p className="text-xs text-amber-600 bg-amber-50 rounded-lg p-2">Nenhum parceiro cadastrado ainda.</p>
              )}
              <Button type="button" variant="outline" size="sm" className="w-full gap-1" onClick={() => onNeedPartner(pessoa)}>
                + Cadastrar novo parceiro
              </Button>
            </div>
          )}

          {conflict && <p className="text-sm text-destructive bg-red-50 rounded-lg px-3 py-2">{conflict}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? t("common.loading") : t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Quick partner create dialog ───────────────────────────────────────────────
function QuickPartnerDialog({ eventId, user, onClose, onSuccess }) {
  const [form, setForm] = useState({ name: "", website: "", contact_email: "", plan: "apoiador" });
  const [saving, setSaving] = useState(false);
  const update = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const partner = await base44.entities.Partner.create({ ...form, event_id: eventId, is_deleted: false });
    logAudit({ event_id: eventId, action: "create", entity_type: "Partner", entity_id: partner.id, user });
    setSaving(false);
    onSuccess();
    toast.success("Parceiro cadastrado com sucesso.");
  };

  const PLANS = [
    { value: "diamante", label: "Diamante" }, { value: "ouro", label: "Ouro" },
    { value: "prata", label: "Prata" }, { value: "bronze", label: "Bronze" }, { value: "apoiador", label: "Apoiador" },
  ];

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="font-display">Cadastrar parceiro</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1"><Label>Nome *</Label><Input value={form.name} onChange={(e) => update("name", e.target.value)} required /></div>
          <div className="space-y-1"><Label>Plano</Label>
            <Select value={form.plan} onValueChange={(v) => update("plan", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{PLANS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><Label>Website</Label><Input value={form.website} onChange={(e) => update("website", e.target.value)} /></div>
          <div className="space-y-1"><Label>E-mail de contato</Label><Input type="email" value={form.contact_email} onChange={(e) => update("contact_email", e.target.value)} /></div>
          <p className="text-xs text-muted-foreground">Após salvar, você retornará ao fluxo de edição da pessoa.</p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={saving}>{saving ? t("common.loading") : "Salvar parceiro"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
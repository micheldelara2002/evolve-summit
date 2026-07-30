import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { filterPartnersByAccess, canManagePartner, isAdmin, canAccessPartnerAdmin } from "@/lib/access";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Building2, Search, Plus, MoreVertical, Pencil, UserPlus,
  UserCheck, UserX, Star, Trash2, Upload,
} from "lucide-react";
import { toast } from "sonner";
import { sanitizeText } from "@/utils/sanitize";
import { uploadFile } from "@/lib/apiClient";
import PageHeader from "@/components/layout/PageHeader";

// ────────────────────────────────────────────────────────────────
// Enums fixos
// ────────────────────────────────────────────────────────────────
const COUNTRY_OPTIONS = [
  { value: "BR", label: "Brasil" },
  { value: "US", label: "EUA" },
  { value: "AR", label: "Argentina" },
  { value: "MX", label: "México" },
  { value: "PT", label: "Portugal" },
  { value: "ES", label: "Espanha" },
  { value: "OTHER", label: "Outro" },
];

const DOC_TYPE_OPTIONS = [
  { value: "CNPJ", label: "CNPJ" },
  { value: "EIN", label: "EIN" },
  { value: "VAT", label: "VAT" },
  { value: "TAX_ID", label: "TAX ID" },
  { value: "OTHER", label: "Outro" },
];

const ROLE_OPTIONS = [
  { value: "partner_manager", label: "Gestor" },
  { value: "representative", label: "Representante" },  
];

function sanitizeDoc(n) { return (n || "").replace(/\D/g, ""); }

const EMPTY_PARTNER = {
  trade_name: "", legal_name: "",
  legal_country_code: "BR", legal_document_type: "CNPJ", legal_document_number: "",
  contact_email: "", contact_phone: "", website: "", about: "",
  logo_url: "", is_active: true,
};

// ────────────────────────────────────────────────────────────────
// PartnerFormDialog
// ────────────────────────────────────────────────────────────────
function PartnerFormDialog({ partner, onClose, onSaved, allPartners = [] }) {
  const [form, setForm] = useState(partner ? { ...partner } : { ...EMPTY_PARTNER });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState({});

  const set = (k, v) => { setForm((p) => ({ ...p, [k]: v })); setErrors((e) => ({ ...e, [k]: null })); };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/svg+xml"];
    if (!allowed.includes(file.type)) { toast.error("Use jpg, png, webp ou svg."); return; }
    if (file.size > 5 * 1024 * 1024) { toast.error("Máximo 5MB."); return; }
    setUploading(true);
    try {
      const { file_url } = await uploadFile(file);
      set("logo_url", file_url);
      toast.success("Logo carregado.");
    } catch { toast.error("Erro ao enviar logo."); }
    finally { setUploading(false); }
  };

  const handleSave = async () => {
    const errs = {};
    if (!form.trade_name?.trim()) errs.trade_name = "Nome comercial é obrigatório.";
    if (!form.legal_name?.trim()) errs.legal_name = "Razão social é obrigatória.";
    if (!form.legal_document_number?.trim()) errs.legal_document_number = "Documento é obrigatório.";
    if (Object.keys(errs).length) { setErrors(errs); return; }

    // Unicidade de documento (runtime)
    const sanitized = sanitizeDoc(form.legal_document_number);
    const duplicate = allPartners.find(
      (p) =>
        p.id !== partner?.id &&
        !p.is_deleted &&
        p.legal_country_code === form.legal_country_code &&
        p.legal_document_type === form.legal_document_type &&
        sanitizeDoc(p.legal_document_number) === sanitized
    );
    if (duplicate) {
      setErrors({ legal_document_number: `Documento já cadastrado para: ${duplicate.trade_name}` });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        trade_name: sanitizeText(form.trade_name.trim()),
        legal_name: sanitizeText(form.legal_name.trim()),
        legal_country_code: form.legal_country_code,
        legal_document_type: form.legal_document_type,
        legal_document_number: form.legal_document_number.trim(),
        contact_email: form.contact_email?.trim() || "",
        contact_phone: form.contact_phone?.trim() || "",
        website: form.website?.trim() || "",
        about: sanitizeText(form.about?.trim() || ""),
        logo_url: form.logo_url || "",
        is_active: form.is_active ?? true,
      };
      if (partner?.id) {
        await base44.entities.Partner.update(partner.id, payload);
      } else {
        await base44.entities.Partner.create(payload);
      }
      onSaved();
    } catch (err) { toast.error("Erro: " + err.message); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{partner?.id ? "Editar Empresa" : "Nova Empresa"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Logo */}
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-xl border border-border bg-muted/30 flex items-center justify-center overflow-hidden shrink-0">
              {form.logo_url
                ? <img src={form.logo_url} alt="logo" className="w-full h-full object-contain" />
                : <Building2 className="w-7 h-7 text-muted-foreground/40" />
              }
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="cursor-pointer">
                <input type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" className="hidden" onChange={handleLogoUpload} />
                <Button type="button" variant="outline" size="sm" disabled={uploading} asChild>
                  <span className="gap-1.5"><Upload className="w-3.5 h-3.5" />{uploading ? "Enviando..." : "Upload logo"}</span>
                </Button>
              </label>
              {form.logo_url && (
                <Button type="button" variant="ghost" size="sm" className="text-destructive text-xs h-7" onClick={() => set("logo_url", "")}>
                  Remover
                </Button>
              )}
            </div>
          </div>

          {/* Dados comerciais */}
          <div className="space-y-1">
            <Label className="text-xs">Nome comercial (trade_name) *</Label>
            <Input value={form.trade_name} onChange={(e) => set("trade_name", e.target.value)} className={errors.trade_name ? "border-destructive" : ""} />
            {errors.trade_name && <p className="text-xs text-destructive">{errors.trade_name}</p>}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Razão social (legal_name) *</Label>
            <Input value={form.legal_name} onChange={(e) => set("legal_name", e.target.value)} className={errors.legal_name ? "border-destructive" : ""} />
            {errors.legal_name && <p className="text-xs text-destructive">{errors.legal_name}</p>}
          </div>

          {/* Documento legal */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">País *</Label>
              <select
                className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={form.legal_country_code}
                onChange={(e) => set("legal_country_code", e.target.value)}
              >
                {COUNTRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tipo doc. *</Label>
              <select
                className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={form.legal_document_type}
                onChange={(e) => set("legal_document_type", e.target.value)}
              >
                {DOC_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Número do documento *</Label>
            <Input value={form.legal_document_number} onChange={(e) => set("legal_document_number", e.target.value)} placeholder="00.000.000/0000-00" className={errors.legal_document_number ? "border-destructive" : ""} />
            {errors.legal_document_number && <p className="text-xs text-destructive">{errors.legal_document_number}</p>}
          </div>

          {/* Contato */}
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">E-mail de contato</Label>
              <Input type="email" value={form.contact_email} onChange={(e) => set("contact_email", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Telefone</Label>
              <Input value={form.contact_phone} onChange={(e) => set("contact_phone", e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Site</Label>
            <Input type="url" value={form.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Sobre a empresa</Label>
            <Textarea value={form.about} onChange={(e) => set("about", e.target.value)} rows={3} />
          </div>
        </div>

        <DialogFooter className="gap-2 mt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || uploading}>{saving ? "Salvando..." : "Salvar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────
// RepresentativesDialog
// ────────────────────────────────────────────────────────────────
function RepresentativesDialog({ partner, onClose }) {
  const [newRep, setNewRep] = useState({ person_id: "", role_in_partner: "partner_manager", is_primary: false });
  const [adding, setAdding] = useState(false);
  const [personSearch, setPersonSearch] = useState("");

  const { data: reps = [], refetch: refetchReps } = useQuery({
    queryKey: ["partner_reps", partner.id],
    queryFn: () => base44.entities.PartnerRepresentative.filter({ partner_id: partner.id, is_deleted: false }),
  });

  const { data: allPersons = [] } = useQuery({
    queryKey: ["persons_for_rep"],
    queryFn: () => base44.entities.Person.list("-full_name", 200),
  });

  const filteredPersons = allPersons.filter((p) =>
    !personSearch || p.full_name?.toLowerCase().includes(personSearch.toLowerCase())
  );

  const handleAdd = async () => {
    if (!newRep.person_id) { toast.error("Selecione uma pessoa."); return; }
    // Checar duplicidade ativa
    const dup = reps.find(
      (r) => r.person_id === newRep.person_id && r.role_in_partner === newRep.role_in_partner && r.is_active
    );
    if (dup) { toast.error("Vínculo ativo já existe para essa pessoa e papel."); return; }
    // Máximo 1 primário
    if (newRep.is_primary) {
      const others = reps.filter((r) => r.is_primary && r.is_active);
      await Promise.all(others.map((r) => base44.entities.PartnerRepresentative.update(r.id, { is_primary: false })));
    }
    await base44.entities.PartnerRepresentative.create({
      partner_id: partner.id,
      person_id: newRep.person_id,
      role_in_partner: newRep.role_in_partner,
      is_primary: newRep.is_primary,
      is_active: true,
    });
    setNewRep({ person_id: "", role_in_partner: "partner_manager", is_primary: false });
    setAdding(false);
    setPersonSearch("");
    refetchReps();
    toast.success("Representante adicionado.");
  };

  const handleToggleActive = async (rep) => {
    await base44.entities.PartnerRepresentative.update(rep.id, { is_active: !rep.is_active });
    refetchReps();
  };

  const handleSetPrimary = async (rep) => {
    const others = reps.filter((r) => r.id !== rep.id && r.is_primary);
    await Promise.all(others.map((r) => base44.entities.PartnerRepresentative.update(r.id, { is_primary: false })));
    await base44.entities.PartnerRepresentative.update(rep.id, { is_primary: true });
    refetchReps();
  };

  const handleDelete = async (id) => {
    await base44.entities.PartnerRepresentative.update(id, { is_deleted: true });
    refetchReps();
  };

  const personMap = Object.fromEntries(allPersons.map((p) => [p.id, p]));

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Representantes — {partner.trade_name}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 pt-1">
          {reps.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">Nenhum representante vinculado.</p>
          )}
          {reps.map((rep) => {
            const person = personMap[rep.person_id];
            return (
              <div key={rep.id} className={`flex items-center justify-between border rounded-lg px-3 py-2 gap-2 ${!rep.is_active ? "opacity-50" : ""}`}>
                <div className="min-w-0 text-sm">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium truncate">{person?.full_name ?? rep.person_id}</span>
                    {rep.is_primary && <Badge variant="secondary" className="text-[10px] py-0">Principal</Badge>}
                    {!rep.is_active && <Badge variant="outline" className="text-[10px] py-0">Inativo</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">{ROLE_OPTIONS.find((r) => r.value === rep.role_in_partner)?.label ?? rep.role_in_partner}</div>
                </div>
                <div className="flex gap-1 shrink-0">
                  {!rep.is_primary && rep.is_active && (
                    <Button type="button" variant="ghost" size="icon" className="w-7 h-7" title="Tornar principal" onClick={() => handleSetPrimary(rep)}>
                      <Star className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="icon" className="w-7 h-7" onClick={() => handleToggleActive(rep)} title={rep.is_active ? "Inativar" : "Reativar"}>
                    {rep.is_active ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="w-7 h-7 text-destructive" onClick={() => handleDelete(rep.id)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}

          {adding ? (
            <div className="border border-dashed rounded-lg p-3 space-y-2 bg-muted/20">
              <div className="space-y-1">
                <Label className="text-xs">Buscar pessoa</Label>
                <Input placeholder="Nome..." value={personSearch} onChange={(e) => setPersonSearch(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Pessoa *</Label>
                <select
                  className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
                  value={newRep.person_id}
                  onChange={(e) => setNewRep((p) => ({ ...p, person_id: e.target.value }))}
                >
                  <option value="">Selecione...</option>
                  {filteredPersons.map((p) => (
                    <option key={p.id} value={p.id}>{p.full_name} {p.contact_email ? `(${p.contact_email})` : ""}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Papel *</Label>
                <select
                  className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
                  value={newRep.role_in_partner}
                  onChange={(e) => setNewRep((p) => ({ ...p, role_in_partner: e.target.value }))}
                >
                  {ROLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={newRep.is_primary} onChange={(e) => setNewRep((p) => ({ ...p, is_primary: e.target.checked }))} />
                Definir como principal
              </label>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => { setAdding(false); setPersonSearch(""); }}>Cancelar</Button>
                <Button type="button" size="sm" className="flex-1" onClick={handleAdd}>Salvar</Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" className="w-full gap-1" onClick={() => setAdding(true)}>
              <UserPlus className="w-3.5 h-3.5" /> Adicionar representante
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────
// Main Page
// ────────────────────────────────────────────────────────────────
const PAGE_SIZE = 20;

export default function AdminPartners() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterCountry, setFilterCountry] = useState("all");
  const [page, setPage] = useState(1);
  const [editingPartner, setEditingPartner] = useState(null);
  const [repsForPartner, setRepsForPartner] = useState(null);

  const { data: allPartners = [], isLoading } = useQuery({
    queryKey: ["admin_partners"],
    queryFn: () => base44.entities.Partner.list("-created_date", 500),
  });

  // Reps do usuário atual (para partner_manager scope) — busca por user_id OU person_id
  const { data: myReps = [] } = useQuery({
    queryKey: ["my_partner_reps", user?.id, user?.person_id],
    queryFn: async () => {
      const all = await base44.entities.PartnerRepresentative.filter({ is_deleted: false });
      return all.filter((r) => r.is_active && (r.user_id === user?.id || r.person_id === user?.person_id));
    },
    enabled: !!user?.id && !isAdmin(user),
  });

  // Filtrar por permissão
  const scopedPartners = filterPartnersByAccess(
    allPartners.filter((p) => !p.is_deleted),
    user,
    myReps
  );

  // Filtros de UI
  const filtered = scopedPartners.filter((p) => {
    const q = search.toLowerCase();
    const matchSearch = !q ||
      p.trade_name?.toLowerCase().includes(q) ||
      p.legal_name?.toLowerCase().includes(q) ||
      p.legal_document_number?.includes(q) ||
      p.contact_email?.toLowerCase().includes(q);
    const matchStatus =
      filterStatus === "all" ||
      (filterStatus === "active" && p.is_active !== false) ||
      (filterStatus === "inactive" && p.is_active === false);
    const matchCountry = filterCountry === "all" || p.legal_country_code === filterCountry;
    return matchSearch && matchStatus && matchCountry;
  });

  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  const handleToggleActive = async (partner) => {
    await base44.entities.Partner.update(partner.id, { is_active: !partner.is_active });
    queryClient.invalidateQueries({ queryKey: ["admin_partners"] });
    toast.success(partner.is_active ? "Empresa inativada." : "Empresa reativada.");
  };

  const handleDelete = async (partner) => {
    await base44.entities.Partner.update(partner.id, { is_deleted: true });
    queryClient.invalidateQueries({ queryKey: ["admin_partners"] });
    toast.success("Empresa removida.");
  };

  const onSaved = () => {
    queryClient.invalidateQueries({ queryKey: ["admin_partners"] });
    setEditingPartner(null);
    toast.success("Empresa salva.");
  };

  // Guard: apenas admin e partner_manager acessam; representantes (member) são bloqueados
  if (!canAccessPartnerAdmin(user)) {
    return (
      <div className="text-center py-24 space-y-3 max-w-sm mx-auto">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
          <Building2 className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-display font-bold">Acesso Restrito</h2>
        <p className="text-sm text-muted-foreground">
          Apenas gestores de parceiros e administradores podem acessar esta área.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <PageHeader
        icon={Building2}
        title="Gestão de Parceiros"
        subtitle={`${filtered.length} empresa(s) encontrada(s)`}
        tone="warning"
        actions={isAdmin(user) ? (
          <Button onClick={() => setEditingPartner({})} className="gap-2">
            <Plus className="w-4 h-4" /> Nova Empresa
          </Button>
        ) : undefined}
      />

      {/* Filtros */}
      <Card>
        <CardContent className="pt-4 pb-4 flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-52">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Buscar por nome, documento, e-mail..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-9"
            />
          </div>
          <div className="flex gap-1 flex-wrap">
            {[{ value: "all", label: "Todos" }, { value: "active", label: "Ativos" }, { value: "inactive", label: "Inativos" }].map((opt) => (
              <Button key={opt.value} variant={filterStatus === opt.value ? "default" : "outline"} size="sm"
                onClick={() => { setFilterStatus(opt.value); setPage(1); }}>
                {opt.label}
              </Button>
            ))}
          </div>
          <select
            className="rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
            value={filterCountry}
            onChange={(e) => { setFilterCountry(e.target.value); setPage(1); }}
          >
            <option value="all">Todos os países</option>
            {COUNTRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </CardContent>
      </Card>

      {/* Lista */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : paginated.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Building2 className="w-10 h-10 text-muted-foreground/40" />
          <p className="text-muted-foreground">Nenhuma empresa encontrada.</p>
          {isAdmin(user) && <Button variant="outline" onClick={() => setEditingPartner({})}>Criar primeira empresa</Button>}
        </div>
      ) : (
        <div className="space-y-2">
          {paginated.map((partner) => (
            <Card key={partner.id} className={partner.is_active === false ? "opacity-60" : ""}>
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Logo */}
                    <div className="w-10 h-10 rounded-lg border border-border bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden">
                      {partner.logo_url
                        ? <img src={partner.logo_url} alt={partner.trade_name} className="w-full h-full object-contain" />
                        : <Building2 className="w-5 h-5 text-muted-foreground/40" />
                      }
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{partner.trade_name}</span>
                        {partner.is_active === false && <Badge variant="outline" className="text-[10px] py-0">Inativo</Badge>}
                        <Badge variant="outline" className="text-[10px] py-0">{partner.legal_country_code} · {partner.legal_document_type}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {partner.legal_name} · {partner.legal_document_number || "—"}
                      </div>
                    </div>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="shrink-0"><MoreVertical className="w-4 h-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {canManagePartner(user, partner.id, myReps) && (
                        <DropdownMenuItem onClick={() => setEditingPartner(partner)}>
                          <Pencil className="w-4 h-4 mr-2" /> Editar
                        </DropdownMenuItem>
                      )}
                      {canManagePartner(user, partner.id, myReps) && (
                        <DropdownMenuItem onClick={() => setRepsForPartner(partner)}>
                          <UserPlus className="w-4 h-4 mr-2" /> Representantes
                        </DropdownMenuItem>
                      )}
                      {canManagePartner(user, partner.id, myReps) && (
                        <DropdownMenuItem onClick={() => handleToggleActive(partner)}>
                          {partner.is_active !== false
                            ? <><UserX className="w-4 h-4 mr-2" /> Inativar</>
                            : <><UserCheck className="w-4 h-4 mr-2" /> Reativar</>
                          }
                        </DropdownMenuItem>
                      )}
                      {isAdmin(user) && (
                        <DropdownMenuItem className="text-destructive" onClick={() => handleDelete(partner)}>
                          <Trash2 className="w-4 h-4 mr-2" /> Remover
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
          <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>Próxima</Button>
        </div>
      )}

      {/* Dialogs */}
      {editingPartner !== null && (
        <PartnerFormDialog
          partner={editingPartner?.id ? editingPartner : null}
          allPartners={allPartners}
          onClose={() => setEditingPartner(null)}
          onSaved={onSaved}
        />
      )}
      {repsForPartner && (
        <RepresentativesDialog partner={repsForPartner} onClose={() => setRepsForPartner(null)} />
      )}
    </div>
  );
}
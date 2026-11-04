import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Building2, Upload, AlertTriangle, Link2 } from "lucide-react";
import { toast } from "sonner";
import { sanitizeText } from "@/utils/sanitize";
import { uploadFile } from "@/lib/apiClient";
import { incPartnersCounter } from "@/lib/businessCounters";

const COUNTRY_OPTIONS = [
  { value: "BR", label: "Brasil" },
  { value: "US", label: "EUA" },
  { value: "AR", label: "Argentina" },
  { value: "MX", label: "México" },
  { value: "PT", label: "Portugal" },
  { value: "ES", label: "Espanha" },
  { value: "OTHER", label: "Outro" },
];

const DOC_TYPE_OPTIONS = ["CNPJ", "EIN", "VAT", "TAX_ID", "OTHER"];

const EMPTY = {
  trade_name: "",
  legal_name: "",
  identity_mode: "formal",
  legal_country_code: "BR",
  legal_document_type: "CNPJ",
  legal_document_number: "",
  contact_email: "",
  contact_phone: "",
  website: "",
  about: "",
  logo_url: "",
  is_active: true,
};

function sanitizeDoc(value) {
  return (value || "").replace(/[^0-9a-z]/gi, "").toUpperCase();
}

/**
 * Cadastro/edição de parceiro global com identidade revisável.
 * Formal = documento (CNPJ) é a chave; informal = nome normalizado (coletivos,
 * podcast de pessoa física). Antes de gravar, consulta o catálogo global para
 * que o mesmo parceiro não nasça duas vezes em eventos diferentes.
 */
export default function PartnerFormDialog({ partner, onClose, onSaved, onPickExisting }) {
  const editing = !!partner?.id;
  const [form, setForm] = useState(() => ({
    ...EMPTY,
    ...(partner || {}),
    identity_mode: partner?.identity_mode || "formal",
  }));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState({});
  const [candidates, setCandidates] = useState([]);
  const [blocked, setBlocked] = useState(false);
  const [confirmedNew, setConfirmedNew] = useState(false);

  const set = (k, v) => {
    setForm((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k]: null }));
    setCandidates([]);
    setBlocked(false);
    setConfirmedNew(false);
  };

  const informal = form.identity_mode === "informal";

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
    } catch {
      toast.error("Erro ao enviar logo.");
    } finally {
      setUploading(false);
    }
  };

  const validate = () => {
    const errs = {};
    if (!form.trade_name?.trim()) errs.trade_name = "Informe o nome do parceiro.";
    if (!informal && !form.legal_name?.trim()) errs.legal_name = "Razão social é obrigatória.";
    if (!informal && !form.legal_document_number?.trim()) errs.legal_document_number = "Documento é obrigatório (ou marque “sem documento”).";
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const checkDuplicates = async () => {
    try {
      const res = await base44.functions.invoke("searchPartners", {
        query: form.trade_name,
        document: informal ? "" : form.legal_document_number,
        email: form.contact_email,
        excludeId: partner?.id || "",
      });
      const list = res.data?.partners || [];
      const docMatch = !!res.data?.exact_document_match;
      return { list, docMatch, strongMatch: !!res.data?.strong_match };
    } catch {
      return { list: [], docMatch: false, strongMatch: false };
    }
  };

  const persist = async () => {
    setSaving(true);
    try {
      const payload = {
        trade_name: sanitizeText(form.trade_name.trim()),
        legal_name: sanitizeText((form.legal_name || form.trade_name).trim()),
        identity_mode: form.identity_mode,
        legal_country_code: form.legal_country_code,
        legal_document_type: informal ? "NONE" : form.legal_document_type,
        legal_document_number: informal ? "" : form.legal_document_number.trim(),
        contact_email: form.contact_email?.trim() || "",
        contact_phone: form.contact_phone?.trim() || "",
        website: form.website?.trim() || "",
        about: sanitizeText(form.about?.trim() || ""),
        logo_url: form.logo_url || "",
        is_active: form.is_active ?? true,
      };
      if (editing) {
        await base44.functions.invoke("savePartner", { id: partner.id, payload });
        onSaved(partner.id);
        return;
      }
      const created = await base44.functions.invoke("savePartner", { payload });
      try { await incPartnersCounter(created?.data?.created_date); } catch { /* reconcile corrige */ }
      toast.success("Parceiro cadastrado.");
      onSaved(created?.data?.id);
    } catch (err) {
      const body = err?.response?.data;
      if (body?.duplicates?.length) {
        setCandidates(body.duplicates);
        setBlocked(true);
        toast.error(body.error || "Já existe um parceiro com esta identidade.");
      } else {
        toast.error(body?.error || err.message || "Não foi possível salvar.");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (!validate()) return;

    if (!confirmedNew && !editing) {
      const { list, docMatch, strongMatch } = await checkDuplicates();
      if (list.length && (docMatch || strongMatch)) {
        setCandidates(list);
        setBlocked(docMatch);
        if (docMatch) {
          toast.error("Documento já cadastrado. Vincule o parceiro existente.");
          return;
        }
        toast.warning("Já existe um parceiro com este nome. Confira antes de continuar.");
        return;
      }
    }
    await persist();
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar parceiro" : "Novo parceiro"}</DialogTitle>
          <DialogDescription>
            O parceiro é global: o mesmo cadastro vale para todos os eventos.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-xl border border-border bg-muted/30 flex items-center justify-center overflow-hidden shrink-0">
              {form.logo_url
                ? <img src={form.logo_url} alt="logo" className="w-full h-full object-contain" />
                : <Building2 className="w-7 h-7 text-muted-foreground/40" />}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="cursor-pointer">
                <input type="file" accept="image/jpeg,image/png,image/webp,image/svg+xml" className="hidden" onChange={handleLogoUpload} />
                <Button type="button" variant="outline" size="sm" disabled={uploading} asChild>
                  <span className="gap-1.5"><Upload className="w-3.5 h-3.5" />{uploading ? "Enviando..." : "Upload logo"}</span>
                </Button>
              </label>
            </div>
          </div>

          {/* Identidade */}
          <div className="space-y-2 rounded-xl border border-border bg-muted/25 p-3">
            <Label className="text-xs">Como este parceiro é identificado?</Label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: "formal", label: "Com CNPJ/documento" },
                { value: "informal", label: "Sem documento" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => set("identity_mode", opt.value)}
                  className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                    form.identity_mode === opt.value ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/40"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {informal
                ? "Coletivos, comunidades e pessoas físicas sem CNPJ. A identidade é o nome normalizado — o sistema avisa se já existir um parecido."
                : "Empresas com CNPJ/TAX ID. O documento é a chave global e impede cadastro duplicado."}
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">{informal ? "Nome do parceiro *" : "Nome comercial *"}</Label>
            <Input
              value={form.trade_name}
              onChange={(e) => set("trade_name", e.target.value)}
              className={errors.trade_name ? "border-destructive" : ""}
              placeholder={informal ? "Ex: Agilistas de São Paulo" : "Ex: Acme Tecnologia"}
            />
            {errors.trade_name && <p className="text-xs text-destructive">{errors.trade_name}</p>}
          </div>

          {!informal && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">Razão social *</Label>
                <Input value={form.legal_name} onChange={(e) => set("legal_name", e.target.value)} className={errors.legal_name ? "border-destructive" : ""} />
                {errors.legal_name && <p className="text-xs text-destructive">{errors.legal_name}</p>}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">País *</Label>
                  <select
                    className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
                    value={form.legal_country_code}
                    onChange={(e) => set("legal_country_code", e.target.value)}
                  >
                    {COUNTRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Tipo doc. *</Label>
                  <select
                    className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
                    value={form.legal_document_type}
                    onChange={(e) => set("legal_document_type", e.target.value)}
                  >
                    {DOC_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Número do documento *</Label>
                <Input
                  value={form.legal_document_number}
                  onChange={(e) => set("legal_document_number", e.target.value)}
                  placeholder="00.000.000/0000-00"
                  className={errors.legal_document_number ? "border-destructive" : ""}
                />
                {errors.legal_document_number && <p className="text-xs text-destructive">{errors.legal_document_number}</p>}
              </div>
            </>
          )}

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
            <Label className="text-xs">Sobre</Label>
            <Textarea rows={3} value={form.about} onChange={(e) => set("about", e.target.value)} />
          </div>

          {candidates.length > 0 && (
            <div className={`rounded-xl border p-3 space-y-2 ${blocked ? "border-destructive/40 bg-destructive/5" : "border-warning/40 bg-warning/5"}`}>
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle className="w-4 h-4" />
                {blocked ? "Este documento já está cadastrado" : "Já existe parceiro com este nome"}
              </div>
              {candidates.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 text-xs rounded-lg bg-card border border-border px-2.5 py-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{c.trade_name}</div>
                    <div className="text-muted-foreground truncate">
                      {c.identity_mode === "informal" ? "Sem documento" : `${c.legal_document_type} ${c.legal_document_number}`}
                      {c.event_count ? ` · ${c.event_count} evento(s)` : ""}
                    </div>
                  </div>
                  {onPickExisting && (
                    <Button size="sm" variant="outline" className="gap-1 shrink-0" onClick={() => onPickExisting(c)}>
                      <Link2 className="w-3.5 h-3.5" /> Usar este
                    </Button>
                  )}
                </div>
              ))}
              {!blocked && (
                <p className="text-[11px] text-muted-foreground">
                  Se for outro parceiro, confirme abaixo. Se for o mesmo, vincule o cadastro existente ao evento.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 mt-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          {!blocked && candidates.length > 0 && (
            <Button
              variant="secondary"
              onClick={() => { setConfirmedNew(true); persist(); }}
              disabled={saving}
            >
              É outro parceiro
            </Button>
          )}
          <Button onClick={handleSave} disabled={saving || uploading || blocked}>
            {saving ? "Salvando..." : editing ? "Salvar" : "Cadastrar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
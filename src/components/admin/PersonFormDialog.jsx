/**
 * Componente compartilhado: modal de criação/edição de Person global.
 * Usado em /admin/people E no fluxo de associação de participante do evento.
 */
import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { sanitizeText } from "@/utils/sanitize";
import { toast } from "sonner";

const FIELDS = [
  { key: "full_name",     label: "Nome completo *", type: "text" },
  { key: "contact_email", label: "E-mail de contato", type: "email" },
  { key: "phone",         label: "Telefone", type: "text" },
  { key: "company",       label: "Empresa", type: "text" },
  { key: "job_title",     label: "Cargo", type: "text" },
  { key: "linkedin",      label: "LinkedIn", type: "url" },
  { key: "instagram",     label: "Instagram", type: "url" },
  { key: "youtube",       label: "YouTube", type: "url" },
  { key: "website",       label: "Site", type: "url" },
];

const EMPTY = {
  full_name: "", contact_email: "", phone: "", company: "",
  job_title: "", bio: "", linkedin: "", instagram: "",
  youtube: "", website: "", is_active: true,
};

/**
 * @param {object|null} person  — null = nova pessoa; objeto = edição
 * @param {function} onClose
 * @param {function} onSaved(person)  — chamado com o objeto Person salvo
 */
export default function PersonFormDialog({ person, onClose, onSaved }) {
  const [form, setForm] = useState(person ? { ...person } : { ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  const set = (k, v) => {
    setForm((p) => ({ ...p, [k]: v }));
    setErrors((e) => ({ ...e, [k]: null }));
  };

  const handleSave = async () => {
    if (!form.full_name?.trim()) {
      setErrors({ full_name: "Nome é obrigatório." });
      return;
    }
    setSaving(true);
    try {
      // Sanitize all string fields before saving
      const cleanForm = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, typeof v === "string" ? sanitizeText(v) : v])
      );
      let saved;
      if (person?.id) {
        await base44.entities.Person.update(person.id, cleanForm);
        saved = { ...person, ...cleanForm };
      } else {
        saved = await base44.entities.Person.create(cleanForm);
      }
      onSaved(saved);
    } catch (err) {
      toast.error("Erro: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{person?.id ? "Editar Pessoa" : "Nova Pessoa"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {FIELDS.map(({ key, label, type }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={key} className="text-xs">{label}</Label>
              <Input
                id={key}
                type={type}
                value={form[key] || ""}
                onChange={(e) => set(key, e.target.value)}
                className={errors[key] ? "border-destructive" : ""}
              />
              {errors[key] && <p className="text-xs text-destructive">{errors[key]}</p>}
            </div>
          ))}
          <div className="space-y-1">
            <Label className="text-xs">Sobre mim</Label>
            <Textarea value={form.bio || ""} onChange={(e) => set("bio", e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
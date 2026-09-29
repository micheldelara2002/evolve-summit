/**
 * Editar dados do participante: atualiza o registro Participant e, quando
 * vinculado a uma Person, sincroniza os campos globais via backend (Lote 4).
 */
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { updateParticipant } from "@/lib/participantApi";
import { saveManagedPerson } from "@/lib/personApi";
import { logAudit } from "@/lib/audit";

export default function EditParticipantDataDialog({ participant, eventId, user, onClose, onSuccess }) {
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
    await updateParticipant(eventId, participant.id, { ...form, cpf: form.cpf.replace(/\D/g, "") });
    // If linked to a Person, sync name/email/phone to Person global (via backend — Lote 4)
    if (participant.person_id) {
      await saveManagedPerson({
        eventId,
        personId: participant.person_id,
        data: {
          full_name: form.full_name,
          contact_email: form.email,
          phone: form.phone,
          company: form.company,
          job_title: form.job_title,
          bio: form.bio,
          linkedin: form.linkedin,
        },
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
import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";

// Manager solicita um evento; nada é criado até o admin aprovar.
export default function EventRequestFormDialog({ onClose, onCreated }) {
  const { user } = useAuth();
  const [form, setForm] = useState({
    name: "",
    description: "",
    start_date: "",
    end_date: "",
    location: "",
    expected_participants: "",
    manager_email: user?.email || "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const handleSubmit = async () => {
    setError("");
    if (!form.name.trim() || !form.start_date) {
      setError("Informe o nome e a data de início do evento.");
      return;
    }
    if (form.end_date && new Date(form.end_date) < new Date(form.start_date)) {
      setError("A data de término não pode ser anterior ao início.");
      return;
    }
    setSaving(true);
    try {
      const res = await base44.functions.invoke("manageEventRequest", {
        action: "create",
        data: {
          ...form,
          expected_participants: form.expected_participants ? Number(form.expected_participants) : null,
        },
      });
      if (res.data?.error) throw new Error(res.data.error);
      toast.success("Solicitação enviada para análise do administrador.");
      onCreated();
    } catch (err) {
      setError(err?.response?.data?.error || err.message || "Não foi possível enviar a solicitação.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Solicitar novo evento</DialogTitle>
          <DialogDescription>
            O evento só é criado depois da aprovação do administrador.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1">
            <Label className="text-xs">Nome do evento *</Label>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Ex: Evolve Summit 2027" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Início *</Label>
              <Input type="datetime-local" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Término</Label>
              <Input type="datetime-local" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Local</Label>
              <Input value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Cidade / espaço" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Público esperado</Label>
              <Input
                type="number"
                min="0"
                value={form.expected_participants}
                onChange={(e) => set("expected_participants", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">E-mail de quem vai gerir</Label>
            <Input
              type="email"
              value={form.manager_email}
              onChange={(e) => set("manager_email", e.target.value)}
              placeholder="gerente@empresa.com"
            />
            <p className="text-[11px] text-muted-foreground">
              Se não tiver conta, o convite é enviado na aprovação.
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Descrição</Label>
            <Textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Observações para o administrador</Label>
            <Textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Enviando..." : "Enviar solicitação"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
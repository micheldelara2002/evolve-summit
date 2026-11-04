import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";

const STATUS_OPTIONS = [
  { value: "draft", label: "Rascunho", hint: "O evento nasce invisível ao público e você libera quando quiser." },
  { value: "active", label: "Ativo", hint: "O evento já fica visível e vendável." },
];

// Aprovação/rejeição — só admin. A aprovação é o único caminho que cria o Event.
export default function EventRequestReviewDialog({ request, mode, onClose, onDone }) {
  const [eventStatus, setEventStatus] = useState("draft");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const approving = mode === "approve";

  const submit = async () => {
    setError("");
    setSaving(true);
    try {
      const res = await base44.functions.invoke("manageEventRequest", {
        action: approving ? "approve" : "reject",
        requestId: request.id,
        eventStatus,
        notes,
      });
      if (res.data?.error) throw new Error(res.data.error);
      toast.success(approving ? "Evento aprovado e criado." : "Solicitação rejeitada.");
      onDone(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err.message || "Não foi possível concluir a análise.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{approving ? "Aprovar solicitação" : "Rejeitar solicitação"}</DialogTitle>
          <DialogDescription>{request?.name}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {approving && (
            <div className="space-y-2">
              <Label className="text-xs">Status inicial do evento</Label>
              <div className="grid gap-2">
                {STATUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setEventStatus(opt.value)}
                    className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                      eventStatus === opt.value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="text-[11px] text-muted-foreground">{opt.hint}</div>
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Quem solicitou (ou o e-mail de gestão indicado) recebe automaticamente o acesso de gerente.
              </p>
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs">{approving ? "Observação (opcional)" : "Motivo da rejeição"}</Label>
            <Textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={approving ? "Ex: contrato assinado, cobrança por evento confirmada." : "Ex: contrato não fechado."}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button
            onClick={submit}
            disabled={saving}
            variant={approving ? "default" : "destructive"}
          >
            {saving ? "Salvando..." : approving ? "Aprovar e criar" : "Rejeitar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
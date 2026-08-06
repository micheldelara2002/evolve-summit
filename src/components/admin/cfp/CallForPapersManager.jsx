import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, Calendar, X, Megaphone } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

const FIELD_TYPES = [
  { value: "text", label: "Texto curto" },
  { value: "textarea", label: "Texto longo" },
  { value: "boolean", label: "Sim/Não" },
  { value: "select", label: "Múltipla escolha" },
];

function parseFormConfig(str) {
  if (!str) return [];
  try { return JSON.parse(str); } catch { return []; }
}

function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function isClosed(cfp) {
  return cfp.end_date && new Date(cfp.end_date) < new Date();
}

export default function CallForPapersManager({ eventId, hasAccess }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const { data: calls = [], isLoading } = useQuery({
    queryKey: ["cfps", eventId],
    queryFn: () => base44.entities.CallForPapers.filter({ event_id: eventId, is_deleted: false }),
  });

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (editing) {
        return base44.entities.CallForPapers.update(editing.id, data);
      }
      return base44.entities.CallForPapers.create({ ...data, event_id: eventId });
    },
    onSuccess: () => {
      qc.invalidateQueries(["cfps", eventId]);
      qc.invalidateQueries(["cfps-open"]);
      setOpen(false);
      setEditing(null);
      toast({ title: editing ? "Chamada atualizada" : "Chamada criada" });
    },
    onError: (e) => toast({ title: "Erro", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.CallForPapers.update(id, { is_deleted: true }),
    onSuccess: () => {
      qc.invalidateQueries(["cfps", eventId]);
      qc.invalidateQueries(["cfps-open"]);
      toast({ title: "Chamada removida" });
    },
  });

  const canEdit = hasAccess;

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex justify-end">
          <Button
            onClick={() => { setEditing(null); setOpen(true); }}
            className="gap-1"
          >
            <Plus className="w-4 h-4" /> Nova Chamada
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-10">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : calls.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Megaphone />
          <p className="mt-2 text-sm">Nenhuma chamada de palestras criada para este evento.</p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {calls.map((cfp) => {
            const closed = isClosed(cfp);
            return (
              <div key={cfp.id} className="rounded-2xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-display font-semibold truncate">{cfp.title}</h3>
                    {cfp.description && <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{cfp.description}</p>}
                  </div>
                  <span className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full ${closed ? "bg-muted text-muted-foreground" : "bg-success/10 text-success"}`}>
                    {closed ? "Encerrada" : "Aberta"}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Calendar className="w-3.5 h-3.5" />
                  {fmtDate(cfp.start_date)} – {fmtDate(cfp.end_date)}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {parseFormConfig(cfp.form_config).length} campo(s) personalizado(s)
                  </span>
                  {canEdit && (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditing(cfp); setOpen(true); }}>
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteMutation.mutate(cfp.id)}>
                        <Trash2 className="w-3.5 h-3.5 text-destructive" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <CfpFormDialog
          editing={editing}
          onClose={() => { setOpen(false); setEditing(null); }}
          onSubmit={(data) => saveMutation.mutate(data)}
          saving={saveMutation.isPending}
        />
      )}
    </div>
  );
}

function CfpFormDialog({ editing, onClose, onSubmit, saving }) {
  const [title, setTitle] = useState(editing?.title || "");
  const [description, setDescription] = useState(editing?.description || "");
  const [startDate, setStartDate] = useState(editing?.start_date?.slice(0, 10) || "");
  const [endDate, setEndDate] = useState(editing?.end_date?.slice(0, 10) || "");
  const [isActive, setIsActive] = useState(editing ? editing.is_active : true);
  const [fields, setFields] = useState(parseFormConfig(editing?.form_config));

  const addField = () => setFields([...fields, { label: "", type: "text", required: false, options: "" }]);
  const updateField = (i, key, val) => setFields(fields.map((f, idx) => idx === i ? { ...f, [key]: val } : f));
  const removeField = (i) => setFields(fields.filter((_, idx) => idx !== i));

  const submit = () => {
    if (!title.trim() || !startDate || !endDate) return;
    const cleanFields = fields.map((f) => ({
      label: f.label?.trim(),
      type: f.type,
      required: !!f.required,
      options: f.type === "select" ? (f.options || "").split(",").map((o) => o.trim()).filter(Boolean) : undefined,
    })).filter((f) => f.label);
    onSubmit({
      title: title.trim(),
      description: description.trim(),
      start_date: new Date(startDate + "T00:00:00").toISOString(),
      end_date: new Date(endDate + "T23:59:59").toISOString(),
      is_active: isActive,
      form_config: JSON.stringify(cleanFields),
    });
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Editar Chamada" : "Nova Chamada"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Título da Chamada *</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Chamada de Palestras 2026" />
          </div>
          <div className="space-y-1">
            <Label>Instruções / Descrição</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Orientações para os proponentes..." />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Abre em *</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Fecha em *</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <Label htmlFor="active" className="cursor-pointer">Chamada ativa</Label>
            <Switch id="active" checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Campos Personalizados</Label>
              <Button variant="outline" size="sm" className="h-7 gap-1" onClick={addField}>
                <Plus className="w-3.5 h-3.5" /> Campo
              </Button>
            </div>
            {fields.length === 0 && (
              <p className="text-xs text-muted-foreground">Toda chamada já inclui Título, Resumo e Tipo. Adicione perguntas extras aqui.</p>
            )}
            {fields.map((f, i) => (
              <div key={i} className="rounded-lg border border-border p-2.5 space-y-2 bg-muted/30">
                <div className="flex gap-2">
                  <Input value={f.label} onChange={(e) => updateField(i, "label", e.target.value)} placeholder="Pergunta" className="flex-1" />
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeField(i)}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
                <div className="flex gap-2 items-center">
                  <Select value={f.type} onValueChange={(v) => updateField(i, "type", v)}>
                    <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {FIELD_TYPES.map((ft) => <SelectItem key={ft.value} value={ft.value}>{ft.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <Switch checked={!!f.required} onCheckedChange={(v) => updateField(i, "required", v)} />
                    Obrigatório
                  </label>
                </div>
                {f.type === "select" && (
                  <Input value={f.options} onChange={(e) => updateField(i, "options", e.target.value)} placeholder="Opções separadas por vírgula" className="h-8" />
                )}
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || !title.trim() || !startDate || !endDate}>
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
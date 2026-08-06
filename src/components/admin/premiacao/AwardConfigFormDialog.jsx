import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, X } from "lucide-react";

const FIELD_TYPES = [
  { value: "text", label: "Texto curto" },
  { value: "textarea", label: "Texto longo" },
  { value: "boolean", label: "Sim/Não" },
  { value: "select", label: "Múltipla escolha" },
];

function parseJSON(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export default function AwardConfigFormDialog({ editing, onClose, onSubmit, saving }) {
  const [title, setTitle] = useState(editing?.title || "");
  const [description, setDescription] = useState(editing?.description || "");
  const [startDate, setStartDate] = useState(editing?.start_date?.slice(0, 10) || "");
  const [endDate, setEndDate] = useState(editing?.end_date?.slice(0, 10) || "");
  const [isActive, setIsActive] = useState(editing ? editing.is_active : true);
  const [fields, setFields] = useState(parseJSON(editing?.form_config, []));
  const [criteria, setCriteria] = useState(parseJSON(editing?.criteria_config, []));

  const addField = () => setFields([...fields, { label: "", type: "text", required: false, options: "" }]);
  const updateField = (i, key, val) => setFields(fields.map((f, idx) => idx === i ? { ...f, [key]: val } : f));
  const removeField = (i) => setFields(fields.filter((_, idx) => idx !== i));

  const addCriterion = () => setCriteria([...criteria, { id: `c${Date.now()}`, label: "", weight: 1, max_score: 10 }]);
  const updateCriterion = (i, key, val) => setCriteria(criteria.map((c, idx) => idx === i ? { ...c, [key]: key === "label" ? val : Number(val) } : c));
  const removeCriterion = (i) => setCriteria(criteria.filter((_, idx) => idx !== i));

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
      criteria_config: JSON.stringify(criteria.filter((c) => c.label.trim())),
    });
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? "Editar Premiação" : "Nova Premiação"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Título da Premiação *</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Prêmio Inovação 2026" />
          </div>
          <div className="space-y-1">
            <Label>Instruções / Descrição</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Orientações para os candidatos..." />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label>Abre em *</Label><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
            <div className="space-y-1"><Label>Fecha em *</Label><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <Label>Premiação ativa</Label>
            <Switch checked={isActive} onCheckedChange={setIsActive} />
          </div>

          <div className="space-y-2 pt-2 border-t border-border">
            <div className="flex items-center justify-between">
              <Label>Formulário de Inscrição</Label>
              <Button variant="outline" size="sm" className="h-7 gap-1" onClick={addField}><Plus className="w-3.5 h-3.5" /> Campo</Button>
            </div>
            <p className="text-xs text-muted-foreground">Toda inscrição já inclui Título e Resumo do case. Adicione perguntas extras aqui.</p>
            {fields.map((f, i) => (
              <div key={i} className="rounded-lg border border-border p-2.5 space-y-2 bg-muted/30">
                <div className="flex gap-2">
                  <Input value={f.label} onChange={(e) => updateField(i, "label", e.target.value)} placeholder="Pergunta" className="flex-1" />
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeField(i)}><X className="w-4 h-4" /></Button>
                </div>
                <div className="flex gap-2 items-center">
                  <Select value={f.type} onValueChange={(v) => updateField(i, "type", v)}>
                    <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>{FIELD_TYPES.map((ft) => <SelectItem key={ft.value} value={ft.value}>{ft.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <Switch checked={!!f.required} onCheckedChange={(v) => updateField(i, "required", v)} /> Obrigatório
                  </label>
                </div>
                {f.type === "select" && (
                  <Input value={f.options} onChange={(e) => updateField(i, "options", e.target.value)} placeholder="Opções separadas por vírgula" className="h-8" />
                )}
              </div>
            ))}
          </div>

          <div className="space-y-2 pt-2 border-t border-border">
            <div className="flex items-center justify-between">
              <Label>Critérios de Avaliação</Label>
              <Button variant="outline" size="sm" className="h-7 gap-1" onClick={addCriterion}><Plus className="w-3.5 h-3.5" /> Critério</Button>
            </div>
            <p className="text-xs text-muted-foreground">Usados pelo comitê de avaliação. O total é a soma de (nota × peso).</p>
            {criteria.map((c, i) => (
              <div key={c.id} className="flex items-end gap-2">
                <div className="flex-1 space-y-1"><Label className="text-xs">Critério {i + 1}</Label><Input value={c.label} onChange={(e) => updateCriterion(i, "label", e.target.value)} placeholder="Ex: Criatividade" /></div>
                <div className="w-16 space-y-1"><Label className="text-xs">Peso</Label><Input type="number" min="0" step="0.1" value={c.weight} onChange={(e) => updateCriterion(i, "weight", e.target.value)} /></div>
                <div className="w-16 space-y-1"><Label className="text-xs">Máx</Label><Input type="number" min="1" value={c.max_score} onChange={(e) => updateCriterion(i, "max_score", e.target.value)} /></div>
                <Button variant="ghost" size="icon" onClick={() => removeCriterion(i)}><X className="w-4 h-4" /></Button>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || !title.trim() || !startDate || !endDate}>{saving ? "Salvando..." : "Salvar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
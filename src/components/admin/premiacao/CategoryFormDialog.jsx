import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2 } from "lucide-react";
import { parseCriteria } from "@/lib/awardUtils";

export default function CategoryFormDialog({ open, onClose, onSaved, eventId, category }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState([]);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(category?.name || "");
      setDescription(category?.description || "");
      setCriteria(category ? parseCriteria(category.criteria_config) : [{ id: "c1", label: "", weight: 1, max_score: 10 }]);
      setIsActive(category?.is_active ?? true);
    }
  }, [open, category]);

  const updateCriterion = (idx, field, value) => {
    setCriteria((prev) => prev.map((c, i) => (i === idx ? { ...c, [field]: field === "label" ? value : Number(value) } : c)));
  };
  const addCriterion = () => setCriteria((p) => [...p, { id: `c${Date.now()}`, label: "", weight: 1, max_score: 10 }]);
  const removeCriterion = (idx) => setCriteria((p) => p.filter((_, i) => i !== idx));

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = {
        event_id: eventId,
        name,
        description,
        criteria_config: JSON.stringify(criteria.filter((c) => c.label.trim())),
        is_active: isActive,
      };
      if (category?.id) await base44.entities.AwardCategory.update(category.id, payload);
      else await base44.entities.AwardCategory.create(payload);
      onSaved?.();
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{category ? "Editar categoria" : "Nova categoria"}</DialogTitle>
          <DialogDescription>Defina os critérios de avaliação.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          <div className="space-y-1">
            <Label>Nome</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Melhor Palestra" />
          </div>
          <div className="space-y-1">
            <Label>Descrição</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Critérios</Label>
              <Button size="sm" variant="ghost" onClick={addCriterion}><Plus className="w-4 h-4" /> Adicionar</Button>
            </div>
            {criteria.map((c, idx) => (
              <div key={c.id} className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">Critério {idx + 1}</Label>
                  <Input value={c.label} onChange={(e) => updateCriterion(idx, "label", e.target.value)} placeholder="Ex: Relevância" />
                </div>
                <div className="w-16 space-y-1">
                  <Label className="text-xs">Peso</Label>
                  <Input type="number" min="0" step="0.1" value={c.weight} onChange={(e) => updateCriterion(idx, "weight", e.target.value)} />
                </div>
                <div className="w-16 space-y-1">
                  <Label className="text-xs">Máx</Label>
                  <Input type="number" min="1" value={c.max_score} onChange={(e) => updateCriterion(idx, "max_score", e.target.value)} />
                </div>
                <Button size="icon" variant="ghost" onClick={() => removeCriterion(idx)}><Trash2 className="w-4 h-4" /></Button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={isActive} onCheckedChange={setIsActive} />
            <Label>Categoria ativa</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
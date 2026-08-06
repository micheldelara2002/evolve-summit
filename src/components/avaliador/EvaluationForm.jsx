import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { parseCriteria, parseScores, criteriaTotal } from "@/lib/awardUtils";

export default function EvaluationForm({ open, onClose, onSaved, nomination, category, existing }) {
  const [scores, setScores] = useState({});
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const criteria = parseCriteria(category?.criteria_config);

  useEffect(() => {
    if (open) {
      setScores(existing ? parseScores(existing.scores) : {});
      setNotes(existing?.notes || "");
    }
  }, [open, existing]);

  const setScore = (id, val) => setScores((p) => ({ ...p, [id]: Number(val) }));
  const total = criteriaTotal(scores, criteria);

  const handleSubmit = async () => {
    setSaving(true);
    try {
      await base44.functions.invoke("manageAward", {
        action: "saveEvaluation",
        nomination_id: nomination.id,
        scores,
        notes,
        status: "submitted",
      });
      onSaved?.();
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Avaliar: {nomination?.nominee_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {nomination?.nominee_subtitle && <p className="text-sm text-muted-foreground">{nomination.nominee_subtitle}</p>}
          {criteria.map((c) => (
            <div key={c.id} className="space-y-1">
              <div className="flex justify-between">
                <Label>{c.label}</Label>
                <span className="text-xs text-muted-foreground">0–{c.max_score} · peso {c.weight}</span>
              </div>
              <Input type="number" min={0} max={c.max_score} value={scores[c.id] ?? ""} onChange={(e) => setScore(c.id, e.target.value)} />
            </div>
          ))}
          <div className="flex justify-between items-center pt-2 border-t border-border">
            <Label>Total</Label>
            <span className="font-display font-bold text-lg">{total}</span>
          </div>
          <div className="space-y-1">
            <Label>Observações</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={handleSubmit} disabled={saving}>Enviar avaliação</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
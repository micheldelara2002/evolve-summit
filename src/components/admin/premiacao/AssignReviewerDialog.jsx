import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Check, UserCheck } from "lucide-react";

export default function AssignReviewerDialog({ open, onClose, eventId, submission, assignedIds }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState([]);

  const { data: reviewers = [], isLoading } = useQuery({
    queryKey: ["event-reviewers", eventId],
    queryFn: () => base44.entities.EventMembership.filter({ event_id: eventId, role: "reviewer", is_active: true, is_deleted: false }),
    enabled: !!eventId,
  });

  useEffect(() => {
    if (open) setSelected(assignedIds || []);
  }, [open, assignedIds]);

  const toggle = (id) => setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);

  const assignMutation = useMutation({
    mutationFn: (reviewer_user_ids) =>
      base44.functions.invoke("manageAward", { action: "assignReviewer", submission_id: submission?.id, reviewer_user_ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["award-submissions", eventId] });
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Designar avaliadores</DialogTitle></DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-6"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
        ) : reviewers.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Nenhum avaliador neste evento ainda. Crie EventMembership com role=reviewer.</p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {reviewers.map((r) => {
              const checked = selected.includes(r.user_id);
              return (
                <button key={r.id} onClick={() => toggle(r.user_id)} className={`w-full flex items-center gap-2 p-2 rounded-lg border text-left transition ${checked ? "border-primary bg-primary/5" : "border-border"}`}>
                  <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${checked ? "bg-primary text-primary-foreground" : "border border-input"}`}>
                    {checked && <Check className="w-3.5 h-3.5" />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{r.person_name || r.user_email}</p>
                    {r.user_email && <p className="text-xs text-muted-foreground truncate">{r.user_email}</p>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => assignMutation.mutate(selected)} disabled={assignMutation.isPending || !submission} className="gap-1">
            <UserCheck className="w-4 h-4" /> {assignMutation.isPending ? "Designando..." : "Designar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
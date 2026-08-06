import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Check, Users } from "lucide-react";

/**
 * Designa a banca avaliadora de uma premiação (AwardConfig).
 * Os avaliadores são escolhidos entre as EventMembership{role:reviewer} do evento
 * e salvos em AwardConfig.assigned_reviewer_ids (JSON de user_ids).
 * Um avaliador só vê as inscrições dos prêmios cuja banca o inclui.
 */
export default function AssignBancaDialog({ open, onClose, eventId, award, currentBanca }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState([]);

  const { data: reviewers = [], isLoading } = useQuery({
    queryKey: ["event-reviewers", eventId],
    queryFn: () => base44.entities.EventMembership.filter({ event_id: eventId, role: "reviewer", is_active: true, is_deleted: false }),
    enabled: !!eventId,
  });

  useEffect(() => { if (open) setSelected(currentBanca || []); }, [open, currentBanca]);

  const toggle = (id) => setSelected((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);

  const saveMutation = useMutation({
    mutationFn: (reviewer_user_ids) =>
      base44.functions.invoke("manageAward", { action: "assignReviewers", award_id: award?.id, reviewer_user_ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["award-configs", eventId] });
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Designar banca avaliadora</DialogTitle></DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-6"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
        ) : reviewers.length === 0 ? (
          <div className="py-4 text-center space-y-1">
            <Users className="w-8 h-8 mx-auto text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Nenhum avaliador neste evento ainda.</p>
            <p className="text-xs text-muted-foreground">Designe pessoas como avaliadoras (role: reviewer) no módulo de Pessoas primeiro.</p>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">Selecione quem compõe a banca desta premiação. Eles verão apenas as inscrições deste prêmio.</p>
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
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => saveMutation.mutate(selected)} disabled={saveMutation.isPending || !award || reviewers.length === 0}>
            {saveMutation.isPending ? "Salvando..." : "Salvar banca"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { FileText, Crown } from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";

const STATUS_STYLE = {
  pending: "bg-warning/10 text-warning",
  in_review: "bg-primary/10 text-primary",
  finalist: "bg-secondary/15 text-secondary",
  winner: "bg-success/10 text-success",
  rejected: "bg-destructive/10 text-destructive",
};
const STATUS_LABEL = {
  pending: "Pendente", in_review: "Em avaliação", finalist: "Finalista", winner: "Vencedor", rejected: "Rejeitado",
};
const PROMOTE_ROLES = [
  { value: "winner", label: "Premiado (acesso ao evento)" },
  { value: "attendee", label: "Participante" },
  { value: "speaker", label: "Palestrante" },
];

function parseJSON(str, fallback) { if (!str) return fallback; try { return JSON.parse(str); } catch { return fallback; } }

export default function AwardSubmissionsManager({ eventId, hasAccess }) {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("pending");
  const [promoteFor, setPromoteFor] = useState(null);

  const { data: configs = [] } = useQuery({ queryKey: ["award-configs", eventId], queryFn: () => base44.entities.AwardConfig.filter({ event_id: eventId, is_deleted: false }) });
  const { data: submissions = [], isLoading } = useQuery({
    queryKey: ["award-submissions", eventId],
    queryFn: () => base44.entities.AwardSubmission.filter({ event_id: eventId, is_deleted: false }),
  });
  const configMap = Object.fromEntries(configs.map((c) => [c.id, c]));

  const statusMutation = useMutation({
    mutationFn: ({ id, status }) => base44.entities.AwardSubmission.update(id, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["award-submissions", eventId] }),
  });
  const promoteMutation = useMutation({
    mutationFn: ({ submission_id, status, new_role }) =>
      base44.functions.invoke("manageAward", { action: "promoteWinner", submission_id, status, new_role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["award-submissions", eventId] });
      setPromoteFor(null);
    },
  });

  const filtered = statusFilter === "all" ? submissions : submissions.filter((s) => s.status === statusFilter);
  const counts = ["pending", "in_review", "finalist", "winner", "rejected"].reduce((acc, st) => {
    acc[st] = submissions.filter((s) => s.status === st).length; return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[{ v: "pending", l: "Pendentes" }, { v: "in_review", l: "Em avaliação" }, { v: "finalist", l: "Finalistas" }, { v: "winner", l: "Vencedores" }, { v: "rejected", l: "Rejeitados" }, { v: "all", l: "Todas" }].map((f) => (
          <button key={f.v} onClick={() => setStatusFilter(f.v)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${statusFilter === f.v ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}>
            {f.l} <span className="opacity-70">({f.v === "all" ? submissions.length : counts[f.v]})</span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={FileText} title="Nenhuma inscrição" description="As inscrições de cases aparecerão aqui." />
      ) : (
        <div className="space-y-3">
          {filtered.map((s) => {
            const cfg = configMap[s.award_id];
            const fields = parseJSON(cfg?.form_config, []);
            const answers = parseJSON(s.custom_answers, {});
            return (
              <div key={s.id} className="rounded-2xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-display font-semibold truncate">{s.title}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">por {s.submitter_name} · {cfg?.title || "—"}</p>
                  </div>
                  <span className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLE[s.status]}`}>{STATUS_LABEL[s.status]}</span>
                </div>

                {s.summary && <p className="text-sm text-muted-foreground line-clamp-3">{s.summary}</p>}

                {fields.length > 0 && (
                  <div className="rounded-lg bg-muted/40 p-2.5 space-y-1 text-xs">
                    {fields.map((f, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="text-muted-foreground shrink-0">{f.label}:</span>
                        <span className="font-medium">{answers[f.label] === undefined || answers[f.label] === "" ? "—" : String(answers[f.label])}</span>
                      </div>
                    ))}
                  </div>
                )}

                {hasAccess && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {s.status !== "winner" && (
                      <Button size="sm" className="h-7 gap-1 bg-success text-success-foreground hover:bg-success/90" onClick={() => setPromoteFor(s)}>
                        <Crown className="w-3.5 h-3.5" /> Promover
                      </Button>
                    )}
                    <Select value={s.status} onValueChange={(v) => statusMutation.mutate({ id: s.id, status: v })}>
                      <SelectTrigger className="h-7 w-36 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(STATUS_LABEL).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {promoteFor && (
        <PromoteDialog
          submission={promoteFor}
          onClose={() => setPromoteFor(null)}
          onConfirm={(status, new_role) => promoteMutation.mutate({ submission_id: promoteFor.id, status, new_role })}
          saving={promoteMutation.isPending}
        />
      )}
    </div>
  );
}

function PromoteDialog({ submission, onClose, onConfirm, saving }) {
  const [status, setStatus] = useState("winner");
  const [newRole, setNewRole] = useState("winner");
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Promover inscrição</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Defina o status e o papel do candidato. Promover libera o acesso ao evento.</p>
          <div className="space-y-1">
            <Label className="text-xs">Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="finalist">Finalista</SelectItem>
                <SelectItem value="winner">Vencedor</SelectItem>
                <SelectItem value="rejected">Rejeitado</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {status !== "rejected" && (
            <div className="space-y-1">
              <Label className="text-xs">Papel do candidato no evento</Label>
              <Select value={newRole} onValueChange={setNewRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PROMOTE_ROLES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => onConfirm(status, status === "rejected" ? undefined : newRole)} disabled={saving}>{saving ? "Processando..." : "Confirmar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
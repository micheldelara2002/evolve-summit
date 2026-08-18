import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Check, X, Clock, Ban, FileText } from "lucide-react";

const STATUS_STYLE = {
  pending: "bg-warning/10 text-warning",
  approved: "bg-success/10 text-success",
  rejected: "bg-destructive/10 text-destructive",
  waitlist: "bg-primary/10 text-primary",
  cancelled: "bg-muted text-muted-foreground",
};
const STATUS_LABEL = {
  pending: "Pendente",
  approved: "Aprovada",
  rejected: "Reprovada",
  waitlist: "Em espera",
  cancelled: "Cancelada",
};

function parseJSON(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export default function SubmissionsReview({ eventId, hasAccess, user }) {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("pending");
  const [selected, setSelected] = useState(null);
  const [notes, setNotes] = useState("");
  const [action, setAction] = useState(null);

  const { data: calls = [] } = useQuery({
    queryKey: ["cfps", eventId],
    queryFn: () => base44.entities.CallForPapers.filter({ event_id: eventId, is_deleted: false }),
  });

  const cfpIds = calls.map((c) => c.id);
  const { data: submissions = [], isLoading } = useQuery({
    queryKey: ["cfp-submissions", eventId, cfpIds.join(",")],
    queryFn: async () => {
      if (!cfpIds.length) return [];
      const all = await base44.entities.Submission.filter({ event_id: eventId, is_deleted: false });
      return all.filter((s) => cfpIds.includes(s.call_for_papers_id));
    },
    enabled: cfpIds.length > 0,
  });

  const manageMutation = useMutation({
    mutationFn: ({ submission_id, action, review_notes }) =>
      base44.functions.invoke("manageSubmission", { submission_id, action, review_notes }),
    onSuccess: () => {
      qc.invalidateQueries(["cfp-submissions", eventId]);
      qc.invalidateQueries(["sessions", eventId]);
      setSelected(null);
      setNotes("");
      setAction(null);
    },
  });

  const filtered = statusFilter === "all"
    ? submissions
    : submissions.filter((s) => s.status === statusFilter);

  const counts = {
    pending: submissions.filter((s) => s.status === "pending").length,
    approved: submissions.filter((s) => s.status === "approved").length,
    rejected: submissions.filter((s) => s.status === "rejected").length,
    waitlist: submissions.filter((s) => s.status === "waitlist").length,
  };

  const cfpMap = Object.fromEntries(calls.map((c) => [c.id, c]));

  const openAction = (sub, act) => {
    setSelected(sub);
    setNotes(sub.review_notes || "");
    setAction(act);
  };

  const confirm = () => {
    manageMutation.mutate({ submission_id: selected.id, action, review_notes: notes });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[
          { v: "pending", label: "Pendentes", n: counts.pending },
          { v: "approved", label: "Aprovadas", n: counts.approved },
          { v: "waitlist", label: "Em espera", n: counts.waitlist },
          { v: "rejected", label: "Reprovadas", n: counts.rejected },
          { v: "all", label: "Todas", n: submissions.length },
        ].map((f) => (
          <button
            key={f.v}
            onClick={() => setStatusFilter(f.v)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${statusFilter === f.v ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
          >
            {f.label} <span className="opacity-70">({f.n})</span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <FileText className="w-8 h-8 mx-auto opacity-40" />
          <p className="mt-2 text-sm">Nenhuma submissão nesta categoria.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((sub) => {
            const cfp = cfpMap[sub.call_for_papers_id];
            const fields = parseJSON(cfp?.form_config, []);
            const answers = parseJSON(sub.custom_answers, {});
            return (
              <div key={sub.id} className="rounded-2xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-display font-semibold truncate">{sub.title}</h3>
                      <Badge variant="secondary" className="capitalize">{sub.proposed_type}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      por {sub.submitter_name} · {cfp?.title || "—"}
                    </p>
                  </div>
                  <span className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLE[sub.status]}`}>
                    {STATUS_LABEL[sub.status]}
                  </span>
                </div>

                {sub.summary && <p className="text-sm text-muted-foreground line-clamp-3">{sub.summary}</p>}

                {fields.length > 0 && (
                  <div className="rounded-lg bg-muted/40 p-2.5 space-y-1 text-xs">
                    {fields.map((f, i) => (
                      <div key={i} className="flex gap-2">
                        <span className="text-muted-foreground shrink-0">{f.label}:</span>
                        <span className="font-medium">
                          {answers[f.label] === undefined || answers[f.label] === "" ? "—" : String(answers[f.label])}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {sub.review_notes && (
                  <p className="text-xs text-muted-foreground italic">Notas: {sub.review_notes}</p>
                )}

                {hasAccess && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {sub.status !== "approved" && (
                      <Button size="sm" className="h-7 gap-1 bg-success text-success-foreground hover:bg-success/90" onClick={() => openAction(sub, "approve")}>
                        <Check className="w-3.5 h-3.5" /> Aprovar
                      </Button>
                    )}
                    {sub.status === "approved" && (
                      <Button size="sm" variant="outline" className="h-7 gap-1 text-destructive" onClick={() => openAction(sub, "cancel")}>
                        <Ban className="w-3.5 h-3.5" /> Cancelar
                      </Button>
                    )}
                    {sub.status === "pending" && (
                      <>
                        <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => openAction(sub, "waitlist")}>
                          <Clock className="w-3.5 h-3.5" /> Lista de espera
                        </Button>
                        <Button size="sm" variant="outline" className="h-7 gap-1 text-destructive" onClick={() => openAction(sub, "reject")}>
                          <X className="w-3.5 h-3.5" /> Reprovar
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <Dialog open onOpenChange={() => { setSelected(null); setAction(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {action === "approve" && "Aprovar submissão"}
                {action === "reject" && "Reprovar submissão"}
                {action === "waitlist" && "Colocar em lista de espera"}
                {action === "cancel" && "Cancelar submissão aprovada"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {action === "approve" && "A palestra será criada na grade do evento (sem sala/trilha/horário ainda)."}
                {action === "cancel" && "A Session vinculada será removida da grade (soft-delete)."}
              </p>
              <Label>Notas do avaliador (opcional)</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setSelected(null); setAction(null); }}>Cancelar</Button>
              <Button
                onClick={confirm}
                disabled={manageMutation.isPending}
                variant={action === "approve" ? "default" : "outline"}
              >
                {manageMutation.isPending ? "Processando..." : "Confirmar"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
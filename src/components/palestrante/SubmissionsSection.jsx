/**
 * Seção "Minhas Submissões" — lista todas as submissões da pessoa (em todos os eventos).
 * Permite editar (se a chamada não encerrou), reutilizar em outra chamada aberta e excluir.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Pencil, Copy, Trash2, FileText } from "lucide-react";
import { useToast } from "@/components/ui/use-toast";

const STATUS_LABEL = {
  pending: "Pendente",
  approved: "Aprovada",
  rejected: "Reprovada",
  waitlist: "Em espera",
  cancelled: "Cancelada",
};
const STATUS_STYLE = {
  pending: "bg-warning/10 text-warning",
  approved: "bg-success/10 text-success",
  rejected: "bg-destructive/10 text-destructive",
  waitlist: "bg-primary/10 text-primary",
  cancelled: "bg-muted text-muted-foreground",
};

function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

export default function SubmissionsSection({ person }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [reuseTarget, setReuseTarget] = useState(null);

  const personId = person?.id || user?.person_id;

  const { data: mySubmissions = [], isLoading } = useQuery({
    queryKey: ["my-submissions", personId],
    queryFn: async () => {
      if (!personId) return [];
      const all = await base44.entities.Submission.filter({ person_id: personId, is_deleted: false });
      return all.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    },
    enabled: !!personId,
  });

  const { data: events = [] } = useQuery({
    queryKey: ["submission-events", mySubmissions.map((s) => s.event_id).join(",")],
    queryFn: async () => {
      const ids = [...new Set(mySubmissions.map((s) => s.event_id))].filter(Boolean);
      if (!ids.length) return [];
      return base44.entities.Event.filter({ id: { $in: ids } });
    },
    enabled: mySubmissions.length > 0,
  });

  const { data: allCfps = [] } = useQuery({
    queryKey: ["cfps-open"],
    queryFn: async () => {
      const response = await base44.functions.invoke("manageEventConfig", { action: "list", entityName: "CallForPapers" });
      const all = response.data?.records || response.records || [];
      const now = new Date();
      return all.filter((c) => !c.end_date || new Date(c.end_date) > now);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Submission.update(id, { is_deleted: true }),
    onSuccess: () => {
      qc.invalidateQueries(["my-submissions", personId]);
      toast({ title: "Submissão excluída" });
    },
  });

  const reuseMutation = useMutation({
    mutationFn: async ({ source, targetCfp }) => {
      return base44.entities.Submission.create({
        call_for_papers_id: targetCfp.id,
        event_id: targetCfp.event_id,
        person_id: source.person_id,
        submitter_name: source.submitter_name,
        submitter_email: source.submitter_email,
        status: "pending",
        title: source.title,
        summary: source.summary,
        proposed_type: source.proposed_type || "palestra",
        custom_answers: source.custom_answers || "",
        original_submission_id: source.id,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries(["my-submissions", personId]);
      setReuseTarget(null);
      toast({ title: "Submissão copiada para a nova chamada!" });
    },
    onError: (e) => toast({ title: "Erro ao copiar", description: e.message, variant: "destructive" }),
  });

  const eventMap = Object.fromEntries(events.map((e) => [e.id, e]));

  if (!personId) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-display font-semibold flex items-center gap-2">
          <FileText className="w-4 h-4 text-secondary" /> Minhas Submissões
        </h2>
        <Button variant="outline" size="sm" onClick={() => navigate("/cfp")}>
          Submeter nova palestra
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : mySubmissions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">Você ainda não submeteu nenhuma palestra.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => navigate("/cfp")}>
            Ver chamadas abertas
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {mySubmissions.map((sub) => {
            const ev = eventMap[sub.event_id];
            const cfpEndPassed = false; // editabilidade controlada na tela de edição
            return (
              <div key={sub.id} className="rounded-xl border border-border bg-card p-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium truncate">{sub.title}</h3>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${STATUS_STYLE[sub.status]}`}>
                      {STATUS_LABEL[sub.status]}
                    </span>
                    {sub.original_submission_id && (
                      <Badge variant="secondary" className="text-[10px]">reusada</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">
                    {ev?.name || "Evento"} {ev?.start_date && `· ${fmtDate(ev.start_date)}`}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  {sub.status === "pending" && (
                    <>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(`/cfp/${sub.call_for_papers_id}/submit?edit=${sub.id}`)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setReuseTarget(sub)}>
                        <Copy className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => deleteMutation.mutate(sub.id)}>
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {reuseTarget && (
        <ReuseDialog
          source={reuseTarget}
          cfps={allCfps}
          eventMap={eventMap}
          onClose={() => setReuseTarget(null)}
          onConfirm={(targetCfp) => reuseMutation.mutate({ source: reuseTarget, targetCfp })}
          saving={reuseMutation.isPending}
        />
      )}
    </div>
  );
}

function ReuseDialog({ source, cfps, eventMap, onClose, onConfirm, saving }) {
  const [targetId, setTargetId] = useState("");
  const available = cfps.filter((c) => c.event_id !== source.event_id);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reutilizar em outra chamada</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Será criada uma cópia de "{source.title}" como pendente na chamada selecionada. Você poderá ajustar as respostas antes de enviar.
          </p>
          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma outra chamada aberta no momento.</p>
          ) : (
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger><SelectValue placeholder="Selecione a chamada de destino" /></SelectTrigger>
              <SelectContent>
                {available.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.title} · {eventMap[c.event_id]?.name || "Evento"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={!targetId || saving} onClick={() => onConfirm(cfps.find((c) => c.id === targetId))}>
            {saving ? "Copiando..." : "Copiar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Plus, Pencil, Trash2, Calendar, Medal, Users } from "lucide-react";
import { parseCriteria } from "@/lib/awardUtils";
import AwardConfigFormDialog from "./AwardConfigFormDialog";
import AssignBancaDialog from "./AssignBancaDialog";
import EmptyState from "@/components/ui/EmptyState";

function parseIds(str) { try { return JSON.parse(str || '[]'); } catch { return []; } }

function parseFormConfig(str) {
  if (!str) return [];
  try { return JSON.parse(str); } catch { return []; }
}
function fmtDate(d) {
  if (!d) return "";
  return new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function isClosed(c) {
  return c.end_date && new Date(c.end_date) < new Date();
}

export default function AwardConfigsManager({ eventId, hasAccess }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [bancaFor, setBancaFor] = useState(null);

  const { data: configs = [], isLoading } = useQuery({
    queryKey: ["award-configs", eventId],
    queryFn: async () => {
      const response = await base44.functions.invoke("manageEventConfig", { action: "list", entityName: "AwardConfig", eventId });
      return response.data?.records || response.records || [];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (editing) {
        const response = await base44.functions.invoke("manageEventConfig", { action: "update", entityName: "AwardConfig", eventId, id: editing.id, data });
        return response.data?.record || response.record;
      }
      const response = await base44.functions.invoke("manageEventConfig", { action: "create", entityName: "AwardConfig", eventId, data });
      return response.data?.record || response.record;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["award-configs", eventId] });
      qc.invalidateQueries({ queryKey: ["awards-open"] });
      setOpen(false);
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const response = await base44.functions.invoke("manageEventConfig", { action: "delete", entityName: "AwardConfig", eventId, id });
      return response.data?.record || response.record;
    }
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["award-configs", eventId] });
      qc.invalidateQueries({ queryKey: ["awards-open"] });
    },
  });

  return (
    <div className="space-y-4">
      {hasAccess && (
        <div className="flex justify-end">
          <Button onClick={() => { setEditing(null); setOpen(true); }} className="gap-1">
            <Plus className="w-4 h-4" /> Nova Premiação
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-10"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>
      ) : configs.length === 0 ? (
        <EmptyState icon={Medal} title="Nenhuma premiação criada" description="Crie uma premiação com formulário de inscrição e critérios de avaliação." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {configs.map((c) => {
            const closed = isClosed(c);
            return (
              <div key={c.id} className="rounded-2xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-display font-semibold truncate">{c.title}</h3>
                    {c.description && <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{c.description}</p>}
                  </div>
                  <span className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full ${closed ? "bg-muted text-muted-foreground" : "bg-success/10 text-success"}`}>
                    {closed ? "Encerrada" : "Aberta"}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Calendar className="w-3.5 h-3.5" /> {fmtDate(c.start_date)} – {fmtDate(c.end_date)}
                </div>
                <div className="flex items-center justify-between rounded-lg bg-muted/30 px-2.5 py-1.5">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Users className="w-3.5 h-3.5" /> Banca: {parseIds(c.assigned_reviewer_ids).length} avaliador(es)
                  </span>
                  {hasAccess && (
                    <Button variant="outline" size="sm" className="h-7" onClick={() => setBancaFor(c)}>Designar banca</Button>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {parseFormConfig(c.form_config).length} campo(s) · {parseCriteria(c.criteria_config).length} critério(s)
                  </span>
                  {hasAccess && (
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditing(c); setOpen(true); }}><Pencil className="w-3.5 h-3.5" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deleteMutation.mutate(c.id)}><Trash2 className="w-3.5 h-3.5 text-destructive" /></Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <AwardConfigFormDialog
          editing={editing}
          onClose={() => { setOpen(false); setEditing(null); }}
          onSubmit={(data) => saveMutation.mutate(data)}
          saving={saveMutation.isPending}
        />
      )}

      {bancaFor && (
        <AssignBancaDialog
          open
          onClose={() => setBancaFor(null)}
          eventId={eventId}
          award={bancaFor}
          currentBanca={parseIds(bancaFor.assigned_reviewer_ids)}
        />
      )}
    </div>
  );
}
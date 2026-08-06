import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Plus, Pencil, Trash2, Trophy } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import NominationFormDialog from "./NominationFormDialog";
import EmptyState from "@/components/ui/EmptyState";

const STATUS_LABELS = { nominated: "Indicado", finalist: "Finalista", winner: "Vencedor", rejected: "Descartado" };

export default function AwardNominationsManager({ eventId }) {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filterCat, setFilterCat] = useState("all");

  const { data: categories = [] } = useQuery({ queryKey: ["award-categories", eventId], queryFn: () => base44.entities.AwardCategory.filter({ event_id: eventId, is_deleted: false }) });
  const { data: nominations = [] } = useQuery({ queryKey: ["award-nominations", eventId], queryFn: () => base44.entities.AwardNomination.filter({ event_id: eventId, is_deleted: false }) });

  const refresh = () => qc.invalidateQueries({ queryKey: ["award-nominations", eventId] });
  const catName = (id) => categories.find((c) => c.id === id)?.name || "—";
  const visible = filterCat === "all" ? nominations : nominations.filter((n) => n.category_id === filterCat);

  const setStatus = async (nom, status) => { await base44.entities.AwardNomination.update(nom.id, { status }); refresh(); };
  const handleDelete = async (nom) => { await base44.entities.AwardNomination.update(nom.id, { is_deleted: true }); refresh(); };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Select value={filterCat} onValueChange={setFilterCat}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Filtrar categoria" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todas</SelectItem>
            {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }}><Plus className="w-4 h-4" /> Nova indicação</Button>
      </div>
      {visible.length === 0 ? (
        <EmptyState icon={Trophy} title="Nenhuma indicação" description="Indique sessões ou pessoas às categorias." />
      ) : (
        <div className="space-y-2">
          {visible.map((n) => (
            <div key={n.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium truncate">{n.nominee_name}</p>
                  {n.nominee_subtitle && <p className="text-xs text-muted-foreground truncate">{n.nominee_subtitle}</p>}
                  <p className="text-xs text-primary mt-0.5">{catName(n.category_id)}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Select value={n.status} onValueChange={(v) => setStatus(n, v)}>
                    <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>{Object.entries(STATUS_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                  <Button size="icon" variant="ghost" onClick={() => { setEditing(n); setDialogOpen(true); }}><Pencil className="w-4 h-4" /></Button>
                  <Button size="icon" variant="ghost" onClick={() => handleDelete(n)}><Trash2 className="w-4 h-4" /></Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <NominationFormDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSaved={refresh} eventId={eventId} categories={categories} nomination={editing} />
    </div>
  );
}
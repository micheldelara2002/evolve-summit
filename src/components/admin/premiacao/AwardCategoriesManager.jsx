import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Plus, Pencil, Trash2, Award } from "lucide-react";
import { parseCriteria } from "@/lib/awardUtils";
import CategoryFormDialog from "./CategoryFormDialog";
import EmptyState from "@/components/ui/EmptyState";

export default function AwardCategoriesManager({ eventId }) {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const { data: categories = [] } = useQuery({
    queryKey: ["award-categories", eventId],
    queryFn: () => base44.entities.AwardCategory.filter({ event_id: eventId, is_deleted: false }),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["award-categories", eventId] });
  const handleDelete = async (cat) => {
    if (!confirm("Excluir esta categoria?")) return;
    await base44.entities.AwardCategory.update(cat.id, { is_deleted: true });
    refresh();
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }}><Plus className="w-4 h-4" /> Nova categoria</Button>
      </div>
      {categories.length === 0 ? (
        <EmptyState icon={Award} title="Nenhuma categoria criada" description="Crie categorias de premiação com critérios customizados." />
      ) : (
        <div className="space-y-2">
          {categories.map((cat) => (
            <div key={cat.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-display font-semibold">{cat.name}</p>
                  {cat.description && <p className="text-sm text-muted-foreground">{cat.description}</p>}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {parseCriteria(cat.criteria_config).map((c) => (
                      <span key={c.id} className="text-xs px-2 py-0.5 rounded-full bg-muted">{c.label} · peso {c.weight}</span>
                    ))}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button size="icon" variant="ghost" onClick={() => { setEditing(cat); setDialogOpen(true); }}><Pencil className="w-4 h-4" /></Button>
                  <Button size="icon" variant="ghost" onClick={() => handleDelete(cat)}><Trash2 className="w-4 h-4" /></Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <CategoryFormDialog open={dialogOpen} onClose={() => setDialogOpen(false)} onSaved={refresh} eventId={eventId} category={editing} />
    </div>
  );
}
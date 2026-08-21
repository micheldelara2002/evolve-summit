/**
 * Gestão de templates personalizados de certificado dentro da aba de Certificados.
 * Lista templates do evento, permite criar/editar/excluir.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listEventConfig, createEventConfig, updateEventConfig, deleteEventConfig } from "@/lib/eventConfigApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Pencil, Plus, Trash2, Image as ImageIcon, Mic, Users } from "lucide-react";
import { toast } from "sonner";
import TemplateEditor from "./TemplateEditor";

export default function TemplateManager({ eventId, event }) {
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const { data: templates = [] } = useQuery({
    queryKey: ["cert-templates", eventId],
    queryFn: () => listEventConfig("CertificateTemplate", eventId),
  });

  const saveMut = useMutation({
    mutationFn: async ({ data, editingId }) => {
      if (editingId) {
        return updateEventConfig("CertificateTemplate", eventId, editingId, data);
      }
      return createEventConfig("CertificateTemplate", eventId, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cert-templates", eventId] });
      toast.success("Template salvo!");
    },
    onError: () => toast.error("Erro ao salvar template."),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => deleteEventConfig("CertificateTemplate", eventId, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cert-templates", eventId] });
      toast.success("Template excluído.");
    },
  });

  const handleNew = () => { setEditing(null); setEditorOpen(true); };
  const handleEdit = (t) => { setEditing(t); setEditorOpen(true); };
  const handleDelete = (t) => {
    if (!confirm(`Excluir o template "${t.name}"?`)) return;
    deleteMut.mutate(t.id);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Templates personalizados</h3>
          <p className="text-xs text-muted-foreground">Suba sua própria arte e posicione as variáveis</p>
        </div>
        <Button size="sm" variant="outline" className="gap-2" onClick={handleNew}>
          <Plus className="w-4 h-4" /> Novo Template
        </Button>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-8 text-center">
          <ImageIcon className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Nenhum template personalizado ainda.</p>
          <p className="text-xs text-muted-foreground mt-1">Use templates do sistema ou crie o seu próprio.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {templates.map((t) => (
            <div key={t.id} className="rounded-xl border border-border overflow-hidden bg-card">
              <div className="relative h-28 bg-muted">
                {t.background_url && (
                  <img src={t.background_url} alt="" className="w-full h-full object-cover" />
                )}
                <div className="absolute top-2 right-2 flex gap-1">
                  <Button size="icon" variant="secondary" className="w-7 h-7" onClick={() => handleEdit(t)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button size="icon" variant="secondary" className="w-7 h-7" onClick={() => handleDelete(t)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
              <div className="p-3 space-y-1">
                <p className="text-sm font-medium truncate">{t.name}</p>
                <Badge variant={t.tipo === "palestra" ? "secondary" : "outline"} className="text-[10px] gap-1">
                  {t.tipo === "palestra" ? <><Mic className="w-3 h-3" /> Palestra</> : <><Users className="w-3 h-3" /> Participação</>}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}

      {editorOpen && (
        <TemplateEditor
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          onSave={(data) => saveMut.mutateAsync({ data, editingId: editing?.id })}
          eventId={eventId}
          event={event}
          editingTemplate={editing}
        />
      )}
    </div>
  );
}
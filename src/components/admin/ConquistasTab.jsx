/**
 * Aba de Conquistas (container — P3 componentização): matriz 4×3 de badges
 * com ações em massa por categoria/coluna, seed de padrões e formulário.
 * Modelo (constantes/seeds/descrição) e cards/form extraídos em ./conquistas/*.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { logAudit } from "@/lib/audit";
import { listEventConfig, createEventConfig, updateEventConfig, deleteEventConfig } from "@/lib/eventConfigApi";
import { Button } from "@/components/ui/button";
import { Wand2, Power, ToggleLeft } from "lucide-react";
import { toast } from "sonner";
import { COLUNAS, CATEGORIAS, COL_LABELS, CAT_LABELS, CAT_COLORS, DEFAULT_SEEDS } from "@/components/admin/conquistas/badgeModel";
import BadgeCard from "@/components/admin/conquistas/BadgeCard";
import EmptyCell from "@/components/admin/conquistas/EmptyCell";
import BadgeForm from "@/components/admin/conquistas/BadgeForm";

export default function ConquistasTab({ eventId, hasAccess, user }) {
  const queryClient = useQueryClient();
  const [formBadge, setFormBadge] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formPreset, setFormPreset] = useState({});

  const { data: badges = [], isLoading } = useQuery({
    queryKey: ["badges", eventId],
    queryFn: () => listEventConfig("Badge", eventId),
  });

  const saveMut = useMutation({
    mutationFn: async ({ data, id }) => {
      if (id) {
        await updateEventConfig("Badge", eventId, id, data);
        return { id, action: "update" };
      } else {
        const created = await createEventConfig("Badge", eventId, { ...data, is_deleted: false });
        return { id: created.id, action: "create" };
      }
    },
    onSuccess: ({ id, action }) => {
      logAudit({ event_id: eventId, action, entity_type: "Badge", entity_id: id, user });
      queryClient.invalidateQueries({ queryKey: ["badges", eventId] });
      setFormOpen(false);
      toast.success("Badge salva.");
    },
    onError: (err) => toast.error(err.message || "Erro ao salvar."),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, ativo }) => updateEventConfig("Badge", eventId, id, { ativo }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["badges", eventId] }),
    onError: (err) => toast.error(err.message || "Erro."),
  });

  const deleteMut = useMutation({
    mutationFn: ({ id }) => deleteEventConfig("Badge", eventId, id),
    onSuccess: (_, { id }) => {
      logAudit({ event_id: eventId, action: "soft_delete", entity_type: "Badge", entity_id: id, user });
      queryClient.invalidateQueries({ queryKey: ["badges", eventId] });
      toast.success("Badge excluída. A posição está disponível.");
    },
    onError: (err) => toast.error(err.message || "Erro ao excluir."),
  });

  // Seed: preenche apenas posições vazias
  const seedMut = useMutation({
    mutationFn: async () => {
      const existingPos = new Set(badges.map((b) => `${b.categoria}__${b.coluna_progresso}`));
      const toCreate = DEFAULT_SEEDS.filter(
        (d) => !existingPos.has(`${d.categoria}__${d.coluna_progresso}`)
      );
      if (toCreate.length === 0) throw new Error("Todas as posições já estão preenchidas. Nenhuma badge foi criada.");
      await Promise.all(
        toCreate.map((d) => createEventConfig("Badge", eventId, { ...d, is_deleted: false, ativo: true }))
      );
      return toCreate.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["badges", eventId] });
      toast.success(`${count} badge(s) padrão criada(s) nas posições vazias.`);
    },
    onError: (err) => toast.error(err.message || "Erro ao criar padrões."),
  });

  // Toggle por categoria (linha)
  const toggleCategoria = (categoria, ativo) => {
    const targets = badges.filter((b) => b.categoria === categoria);
    Promise.all(targets.map((b) => updateEventConfig("Badge", eventId, b.id, { ativo }))).then(() => {
      queryClient.invalidateQueries({ queryKey: ["badges", eventId] });
      toast.success(`${ativo ? "Ativadas" : "Desativadas"} ${targets.length} badges de ${CAT_LABELS[categoria]}.`);
    });
  };

  // Toggle por coluna
  const toggleColuna = (coluna, ativo) => {
    const targets = badges.filter((b) => b.coluna_progresso === coluna);
    if (targets.length === 0) return;
    Promise.all(targets.map((b) => updateEventConfig("Badge", eventId, b.id, { ativo }))).then(() => {
      queryClient.invalidateQueries({ queryKey: ["badges", eventId] });
      toast.success(`${ativo ? "Ativadas" : "Desativadas"} ${targets.length} badges de ${COL_LABELS[coluna]}.`);
    });
  };

  const openEdit = (badge) => { setFormBadge(badge); setFormPreset({}); setFormOpen(true); };
  const openNew = (preset = {}) => { setFormBadge(null); setFormPreset(preset); setFormOpen(true); };

  const getCell = (categoria, coluna) =>
    badges.find((b) => b.categoria === categoria && b.coluna_progresso === coluna) || null;

  const existingPositions = badges.map((b) => `${b.categoria}__${b.coluna_progresso}`);
  const existingCodigos = badges.map((b) => b.codigo?.toUpperCase());

  if (isLoading) return (
    <div className="flex justify-center py-12">
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">
          {badges.filter((b) => b.ativo).length} de {badges.length} badge(s) ativa(s)
        </p>
        {hasAccess && (
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => seedMut.mutate()}
              disabled={seedMut.isPending}
            >
              <Wand2 className="w-4 h-4" /> Criar Padrão
            </Button>
            <Button size="sm" className="gap-1" onClick={() => openNew()}>
              + Nova Badge
            </Button>
          </div>
        )}
      </div>

      {/* Matriz 4x3 */}
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          {/* Cabeçalho das colunas com ações em massa */}
          <div className="grid grid-cols-[140px_1fr_1fr_1fr_1fr] gap-2 mb-2">
            <div />
            {COLUNAS.map((col) => {
              const colBadges = badges.filter((b) => b.coluna_progresso === col);
              const allAtivo = colBadges.length > 0 && colBadges.every((b) => b.ativo);
              const allInativo = colBadges.length === 0 || colBadges.every((b) => !b.ativo);
              return (
                <div key={col} className="flex flex-col items-center gap-1 py-1.5 px-2 bg-muted/50 rounded-lg">
                  <span className="text-xs font-semibold text-muted-foreground">{COL_LABELS[col]}</span>
                  {hasAccess && colBadges.length > 0 && (
                    <div className="flex gap-1">
                      <button
                        title="Ativar todas da coluna"
                        onClick={() => toggleColuna(col, true)}
                        disabled={allAtivo}
                        className="p-0.5 rounded hover:bg-white/60 disabled:opacity-30 transition"
                      >
                        <Power className="w-3 h-3 text-emerald-600" />
                      </button>
                      <button
                        title="Desativar todas da coluna"
                        onClick={() => toggleColuna(col, false)}
                        disabled={allInativo}
                        className="p-0.5 rounded hover:bg-white/60 disabled:opacity-30 transition"
                      >
                        <ToggleLeft className="w-3 h-3 text-gray-500" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Linhas por categoria */}
          {CATEGORIAS.map((cat) => {
            const catStyle = CAT_COLORS[cat];
            const catBadges = badges.filter((b) => b.categoria === cat);
            const allAtivo = catBadges.length > 0 && catBadges.every((b) => b.ativo);
            const allInativo = catBadges.length === 0 || catBadges.every((b) => !b.ativo);

            return (
              <div key={cat} className="grid grid-cols-[140px_1fr_1fr_1fr_1fr] gap-2 mb-2">
                {/* Rótulo da categoria */}
                <div className={`flex flex-col items-center justify-center gap-1.5 rounded-xl border ${catStyle.border} ${catStyle.bg} p-2`}>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${catStyle.label}`}>
                    {CAT_LABELS[cat]}
                  </span>
                  {hasAccess && (
                    <div className="flex gap-1">
                      <button
                        title="Ativar todas"
                        onClick={() => toggleCategoria(cat, true)}
                        disabled={allAtivo}
                        className="p-1 rounded hover:bg-white/60 disabled:opacity-30 transition"
                      >
                        <Power className="w-3 h-3 text-emerald-600" />
                      </button>
                      <button
                        title="Desativar todas"
                        onClick={() => toggleCategoria(cat, false)}
                        disabled={allInativo}
                        className="p-1 rounded hover:bg-white/60 disabled:opacity-30 transition"
                      >
                        <ToggleLeft className="w-3 h-3 text-gray-500" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Células */}
                {COLUNAS.map((col) => {
                  const cell = getCell(cat, col);
                  return (
                    <div key={col}>
                      {cell ? (
                        <BadgeCard
                          badge={cell}
                          hasAccess={hasAccess}
                          onEdit={openEdit}
                          onToggle={(b) => toggleMut.mutate({ id: b.id, ativo: !b.ativo })}
                          onDelete={(b) => deleteMut.mutate({ id: b.id })}
                        />
                      ) : (
                        <EmptyCell
                          hasAccess={hasAccess}
                          onAdd={() => openNew({ categoria: cat, coluna_progresso: col })}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* Form Dialog */}
      {formOpen && (
        <BadgeForm
          badge={formBadge}
          eventId={eventId}
          existingPositions={existingPositions}
          existingCodigos={existingCodigos}
          onSubmit={(data) => saveMut.mutate({ data, id: formBadge?.id })}
          onClose={() => setFormOpen(false)}
          isSubmitting={saveMut.isPending}
        />
      )}
    </div>
  );
}
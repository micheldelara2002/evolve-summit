import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { logAudit } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, MoreVertical, Pencil, Trash2, Zap, Wand2 } from "lucide-react";
import { toast } from "sonner";

// ── Labels ────────────────────────────────────────────────────────────────────
const ACAO_LABELS = {
  presenca_sessao: "Presença em Sessão",
  avaliacao_sessao: "Avaliação de Sessão",
  pergunta_valida: "Pergunta Válida",
  completude_perfil: "Completude de Perfil",
  conexao_aceita: "Conexão Aceita",
  visita_estande: "Visita a Estande",
};

const LIMITE_LABELS = {
  por_sessao: "Por Sessão",
  por_estande: "Por Estande",
  por_par_usuarios: "Por Par de Usuários",
  one_shot: "Uma vez (one-shot)",
};

const ACOES = Object.keys(ACAO_LABELS);
const LIMITE_TIPOS = Object.keys(LIMITE_LABELS);

// ── Defaults para seed ────────────────────────────────────────────────────────
const DEFAULTS = [
  { acao: "presenca_sessao",   pontos: 100, limite_tipo: "por_sessao",       limite_valor: 1, ativo: true },
  { acao: "avaliacao_sessao",  pontos: 100, limite_tipo: "por_sessao",       limite_valor: 1, ativo: true },
  { acao: "pergunta_valida",   pontos: 100, limite_tipo: "por_sessao",       limite_valor: 1, ativo: true },
  { acao: "completude_perfil", pontos: 100, limite_tipo: "one_shot",         limite_valor: 1, ativo: true },
  { acao: "conexao_aceita",    pontos: 200, limite_tipo: "por_par_usuarios", limite_valor: 1, ativo: true },
  { acao: "visita_estande",    pontos: 300, limite_tipo: "por_estande",      limite_valor: 1, ativo: true },
];

// ── Form Dialog ───────────────────────────────────────────────────────────────
function RuleForm({ rule, existingAcoes, onSubmit, onClose, isSubmitting }) {
  const [form, setForm] = useState({
    acao: rule?.acao ?? "",
    pontos: rule?.pontos ?? 100,
    ativo: rule?.ativo ?? true,
    limite_tipo: rule?.limite_tipo ?? "por_sessao",
    limite_valor: rule?.limite_valor ?? 1,
  });
  const [errors, setErrors] = useState({});

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const validate = () => {
    const errs = {};
    if (!form.acao) errs.acao = "Selecione uma ação.";
    else if (!rule && existingAcoes.includes(form.acao))
      errs.acao = "Já existe uma regra para esta ação neste evento.";
    const pts = Number(form.pontos);
    if (!pts || pts < 100 || pts % 100 !== 0) errs.pontos = "Deve ser múltiplo de 100, mínimo 100.";
    if (!form.limite_tipo) errs.limite_tipo = "Selecione o tipo de limite.";
    const lv = Number(form.limite_valor);
    if (!lv || lv < 1 || !Number.isInteger(lv)) errs.limite_valor = "Mínimo 1.";
    return errs;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    onSubmit({
      acao: form.acao,
      pontos: Number(form.pontos),
      ativo: form.ativo,
      limite_tipo: form.limite_tipo,
      limite_valor: Number(form.limite_valor),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display">{rule ? "Editar Regra" : "Nova Regra de Pontuação"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Ação */}
          <div className="space-y-1.5">
            <Label>Ação *</Label>
            <Select value={form.acao} onValueChange={(v) => set("acao", v)} disabled={!!rule}>
              <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
              <SelectContent>
                {ACOES.map((a) => (
                  <SelectItem key={a} value={a} disabled={!rule && existingAcoes.includes(a)}>
                    {ACAO_LABELS[a]}
                    {!rule && existingAcoes.includes(a) && " (já cadastrada)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.acao && <p className="text-xs text-destructive">{errors.acao}</p>}
          </div>

          {/* Pontos */}
          <div className="space-y-1.5">
            <Label>Pontos * <span className="text-muted-foreground font-normal">(múltiplo de 100)</span></Label>
            <Input
              type="number"
              min={100}
              step={100}
              value={form.pontos}
              onChange={(e) => set("pontos", e.target.value)}
            />
            {errors.pontos && <p className="text-xs text-destructive">{errors.pontos}</p>}
          </div>

          {/* Limite tipo + valor */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Tipo de Limite *</Label>
              <Select value={form.limite_tipo} onValueChange={(v) => set("limite_tipo", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LIMITE_TIPOS.map((lt) => (
                    <SelectItem key={lt} value={lt}>{LIMITE_LABELS[lt]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.limite_tipo && <p className="text-xs text-destructive">{errors.limite_tipo}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Limite (qtd.) *</Label>
              <Input
                type="number"
                min={1}
                step={1}
                value={form.limite_valor}
                onChange={(e) => set("limite_valor", e.target.value)}
              />
              {errors.limite_valor && <p className="text-xs text-destructive">{errors.limite_valor}</p>}
            </div>
          </div>

          {/* Ativo */}
          <div className="flex items-center gap-3">
            <Switch checked={form.ativo} onCheckedChange={(v) => set("ativo", v)} id="ativo-switch" />
            <Label htmlFor="ativo-switch">Regra ativa</Label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={isSubmitting}>{isSubmitting ? "Salvando..." : "Salvar"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Tab ──────────────────────────────────────────────────────────────────
export default function PontuacaoTab({ eventId, hasAccess, user }) {
  const queryClient = useQueryClient();
  const [formRule, setFormRule] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [filterAtivo, setFilterAtivo] = useState("todos");
  const [filterAcao, setFilterAcao] = useState("todas");

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ["scoring-rules", eventId],
    queryFn: () => base44.entities.ScoringRule.filter({ event_id: eventId, is_deleted: false }),
  });

  const saveMut = useMutation({
    mutationFn: async ({ data, id }) => {
      if (id) {
        await base44.entities.ScoringRule.update(id, data);
        return { id, action: "update" };
      } else {
        const created = await base44.entities.ScoringRule.create({ ...data, event_id: eventId, is_deleted: false });
        return { id: created.id, action: "create" };
      }
    },
    onSuccess: ({ id, action }) => {
      logAudit({ event_id: eventId, action, entity_type: "ScoringRule", entity_id: id, user });
      queryClient.invalidateQueries({ queryKey: ["scoring-rules", eventId] });
      setFormOpen(false);
      toast.success("Regra salva com sucesso.");
    },
    onError: (err) => toast.error(err.message || "Erro ao salvar."),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => base44.entities.ScoringRule.update(id, { is_deleted: true }),
    onSuccess: (_, id) => {
      logAudit({ event_id: eventId, action: "soft_delete", entity_type: "ScoringRule", entity_id: id, user });
      queryClient.invalidateQueries({ queryKey: ["scoring-rules", eventId] });
      setDeleteTarget(null);
      toast.success("Regra removida.");
    },
    onError: (err) => toast.error(err.message || "Erro ao excluir."),
  });

  const toggleAtivo = (rule) => {
    saveMut.mutate({ data: { ativo: !rule.ativo }, id: rule.id });
  };

  // Seed: criar regras padrão
  const seedMut = useMutation({
    mutationFn: async () => {
      const existingAcoes = rules.map((r) => r.acao);
      const toCreate = DEFAULTS.filter((d) => !existingAcoes.includes(d.acao));
      if (toCreate.length === 0) throw new Error("Todas as regras padrão já foram criadas.");
      await Promise.all(
        toCreate.map((d) =>
          base44.entities.ScoringRule.create({ ...d, event_id: eventId, is_deleted: false })
        )
      );
      return toCreate.length;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["scoring-rules", eventId] });
      toast.success(`${count} regra(s) padrão criada(s).`);
    },
    onError: (err) => toast.error(err.message || "Erro ao criar regras padrão."),
  });

  // Filtros
  const filtered = rules.filter((r) => {
    if (filterAtivo === "ativo" && !r.ativo) return false;
    if (filterAtivo === "inativo" && r.ativo) return false;
    if (filterAcao !== "todas" && r.acao !== filterAcao) return false;
    return true;
  });

  const existingAcoes = rules.map((r) => r.acao);
  const openNew = () => { setFormRule(null); setFormOpen(true); };
  const openEdit = (rule) => { setFormRule(rule); setFormOpen(true); };

  return (
    <div className="space-y-4">
      {/* Barra de ações */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Filtro ação */}
        <Select value={filterAcao} onValueChange={setFilterAcao}>
          <SelectTrigger className="h-9 w-44">
            <SelectValue placeholder="Todas as ações" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas as ações</SelectItem>
            {ACOES.map((a) => <SelectItem key={a} value={a}>{ACAO_LABELS[a]}</SelectItem>)}
          </SelectContent>
        </Select>

        {/* Filtro ativo */}
        <Select value={filterAtivo} onValueChange={setFilterAtivo}>
          <SelectTrigger className="h-9 w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="ativo">Ativos</SelectItem>
            <SelectItem value="inativo">Inativos</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex-1" />

        {hasAccess && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 shrink-0"
              onClick={() => seedMut.mutate()}
              disabled={seedMut.isPending}
            >
              <Wand2 className="w-4 h-4" /> Criar Padrões
            </Button>
            <Button size="sm" className="gap-1 shrink-0" onClick={openNew}>
              <Plus className="w-4 h-4" /> Nova Regra
            </Button>
          </>
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex justify-center py-8">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Tabela */}
      {!isLoading && (
        <div className="rounded-xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/60 text-left">
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Ação</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-right">Pontos</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Tipo de Limite</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-right">Limite (qtd.)</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Ativo</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Atualizado</th>
                  {hasAccess && <th className="px-3 py-2.5 w-10" />}
                </tr>
              </thead>
              <tbody>
                {filtered.map((rule, idx) => (
                  <tr
                    key={rule.id}
                    className={`border-t border-border ${idx % 2 === 0 ? "bg-card" : "bg-muted/20"} hover:bg-muted/40 transition-colors`}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <Zap className="w-3.5 h-3.5 text-accent shrink-0" />
                        <span className="font-medium text-sm">{ACAO_LABELS[rule.acao] || rule.acao}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Badge className="bg-primary/10 text-primary font-mono">{rule.pontos} pts</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{LIMITE_LABELS[rule.limite_tipo] || rule.limite_tipo}</td>
                    <td className="px-3 py-2.5 text-right text-xs">{rule.limite_valor}</td>
                    <td className="px-3 py-2.5">
                      {hasAccess ? (
                        <Switch
                          checked={rule.ativo}
                          onCheckedChange={() => toggleAtivo(rule)}
                          disabled={saveMut.isPending}
                        />
                      ) : (
                        <Badge className={rule.ativo ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}>
                          {rule.ativo ? "Sim" : "Não"}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">
                      {rule.updated_date ? new Date(rule.updated_date).toLocaleDateString("pt-BR") : "—"}
                    </td>
                    {hasAccess && (
                      <td className="px-3 py-2.5">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openEdit(rule)}>
                              <Pencil className="w-4 h-4 mr-2" /> Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-destructive" onClick={() => setDeleteTarget(rule)}>
                              <Trash2 className="w-4 h-4 mr-2" /> Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <p className="text-center text-muted-foreground py-8 text-sm">
              {rules.length === 0
                ? 'Nenhuma regra cadastrada. Clique em "Criar Padrões" para começar.'
                : "Nenhuma regra encontrada com os filtros aplicados."}
            </p>
          )}
        </div>
      )}

      {/* Resumo total de ações ativas */}
      {!isLoading && rules.length > 0 && (
        <p className="text-xs text-muted-foreground text-right">
          {rules.filter((r) => r.ativo).length} de {rules.length} regra(s) ativa(s)
        </p>
      )}

      {/* Form Dialog */}
      {formOpen && (
        <RuleForm
          rule={formRule}
          existingAcoes={existingAcoes}
          onSubmit={(data) => saveMut.mutate({ data, id: formRule?.id })}
          onClose={() => setFormOpen(false)}
          isSubmitting={saveMut.isPending}
        />
      )}

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirmar exclusão</AlertDialogTitle>
            <AlertDialogDescription>
              Deseja excluir a regra de <strong>{ACAO_LABELS[deleteTarget?.acao]}</strong>?
              Esta ação não poderá ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => deleteMut.mutate(deleteTarget.id)}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
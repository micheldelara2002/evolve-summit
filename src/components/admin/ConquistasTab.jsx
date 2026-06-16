import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { logAudit } from "@/lib/audit";
import { ACAO_EVENTO_LABELS, ACAO_EVENTO_KEYS } from "@/lib/acaoEvento";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MoreVertical, Pencil, Wand2, ToggleLeft, ToggleRight, Power, Trash2 } from "lucide-react";
import { toast } from "sonner";

// ── Constantes fixas da matriz ────────────────────────────────────────────────
const COLUNAS = ["partindo", "aquecendo", "acelerando", "voando"];
const CATEGORIAS = ["engajamento", "conteudo", "networking"];

const COL_LABELS = {
  partindo: "🚀 Partindo",
  aquecendo: "🔥 Aquecendo",
  acelerando: "⚡ Acelerando",
  voando: "🦅 Voando",
};

const CAT_LABELS = {
  engajamento: "Engajamento",
  conteudo: "Conteúdo",
  networking: "Networking",
};

const CAT_COLORS = {
  engajamento: { bg: "bg-blue-50", border: "border-blue-200", label: "bg-blue-100 text-blue-700" },
  conteudo:    { bg: "bg-purple-50", border: "border-purple-200", label: "bg-purple-100 text-purple-700" },
  networking:  { bg: "bg-emerald-50", border: "border-emerald-200", label: "bg-emerald-100 text-emerald-700" },
};

const CRITERIO_LABELS = {
  first: "Primeiro(a)",
  count: "Contagem",
  percent: "Percentual (%)",
  points_total: "Pontos acumulados",
};

const ICONE_SUGESTOES = {
  engajamento: ["🏅", "⭐", "🎯", "💫", "🌟", "🏆", "🎖️", "✨"],
  conteudo:    ["📚", "💡", "🎓", "📖", "🔬", "🎯", "💎", "🧠"],
  networking:  ["🤝", "🌐", "💬", "👥", "🔗", "🌍", "💼", "🤜"],
};

const DEFAULT_SEEDS = [
  // Engajamento
  { codigo: "1A", titulo: "Primeira presença em sessão", categoria: "engajamento", coluna_progresso: "partindo",   criterio_tipo: "first",        acao_referencia: "presenca_sessao",   valor_meta: 1,    icone_emoji: "🏅", icone_cor: "#3B82F6" },
  { codigo: "1B", titulo: "Perfil completo",             categoria: "engajamento", coluna_progresso: "aquecendo",  criterio_tipo: "percent",      acao_referencia: "completude_perfil", valor_meta: 90,   icone_emoji: "⭐", icone_cor: "#60A5FA" },
  { codigo: "1C", titulo: "Presenças acumuladas",        categoria: "engajamento", coluna_progresso: "acelerando", criterio_tipo: "count",        acao_referencia: "presenca_sessao",   valor_meta: 5,    icone_emoji: "🎯", icone_cor: "#2563EB" },
  { codigo: "1D", titulo: "Pontos acumulados",           categoria: "engajamento", coluna_progresso: "voando",     criterio_tipo: "points_total", acao_referencia: null,                valor_meta: 1000, icone_emoji: "🏆", icone_cor: "#1D4ED8" },
  // Conteúdo
  { codigo: "2A", titulo: "Primeira avaliação",          categoria: "conteudo",    coluna_progresso: "partindo",   criterio_tipo: "first",        acao_referencia: "avaliacao_sessao",  valor_meta: 1,  icone_emoji: "📚", icone_cor: "#9333EA" },
  { codigo: "2B", titulo: "Primeiro resgate",            categoria: "conteudo",    coluna_progresso: "aquecendo",  criterio_tipo: "first",        acao_referencia: "resgate_realizado", valor_meta: 1,  icone_emoji: "💡", icone_cor: "#A855F7" },
  { codigo: "2C", titulo: "Avaliações acumuladas",       categoria: "conteudo",    coluna_progresso: "acelerando", criterio_tipo: "count",        acao_referencia: "avaliacao_sessao",  valor_meta: 3,  icone_emoji: "🎓", icone_cor: "#7C3AED" },
  { codigo: "2D", titulo: "Perguntas enviadas",          categoria: "conteudo",    coluna_progresso: "voando",     criterio_tipo: "count",        acao_referencia: "pergunta_valida",   valor_meta: 3,  icone_emoji: "💎", icone_cor: "#6D28D9" },
  // Networking
  { codigo: "3A", titulo: "Primeira conexão",            categoria: "networking",  coluna_progresso: "partindo",   criterio_tipo: "first",        acao_referencia: "conexao_aceita",    valor_meta: 1,  icone_emoji: "🤝", icone_cor: "#059669" },
  { codigo: "3B", titulo: "Primeiro estande visitado",   categoria: "networking",  coluna_progresso: "aquecendo",  criterio_tipo: "first",        acao_referencia: "visita_estande",    valor_meta: 1,  icone_emoji: "🌐", icone_cor: "#10B981" },
  { codigo: "3C", titulo: "Conexões acumuladas",         categoria: "networking",  coluna_progresso: "acelerando", criterio_tipo: "count",        acao_referencia: "conexao_aceita",    valor_meta: 5,  icone_emoji: "💬", icone_cor: "#047857" },
  { codigo: "3D", titulo: "Cobertura de estandes",       categoria: "networking",  coluna_progresso: "voando",     criterio_tipo: "percent",      acao_referencia: "visita_estande",    valor_meta: 90, icone_emoji: "🌍", icone_cor: "#065F46" },
];

// ── Descrição automática ──────────────────────────────────────────────────────
function gerarDescricao(criterio_tipo, acao_referencia, valor_meta) {
  const meta = Number(valor_meta);
  const acaoLabel = acao_referencia ? ACAO_EVENTO_LABELS[acao_referencia] : null;

  const verbos = {
    presenca_sessao:   "Registrar presença em pelo menos",
    avaliacao_sessao:  "Avaliar pelo menos",
    pergunta_valida:   "Enviar pelo menos",
    completude_perfil: "Completar pelo menos",
    conexao_aceita:    "Realizar pelo menos",
    visita_estande:    "Visitar pelo menos",
    resgate_realizado: "Resgatar pelo menos",
  };

  const sufixos = {
    presenca_sessao:   meta === 1 ? "sessão." : "sessões.",
    avaliacao_sessao:  meta === 1 ? "sessão." : "sessões.",
    pergunta_valida:   meta === 1 ? "pergunta válida." : "perguntas válidas.",
    completude_perfil: "% do perfil.",
    conexao_aceita:    meta === 1 ? "conexão aceita." : "conexões aceitas.",
    visita_estande:    meta === 1 ? "estande." : "estandes.",
    resgate_realizado: meta === 1 ? "item resgatado." : "itens resgatados.",
  };

  if (criterio_tipo === "points_total") {
    return `Acumular pelo menos ${meta} pontos.`;
  }

  if (criterio_tipo === "first" && acao_referencia) {
    const sufixo = sufixos[acao_referencia] || (acaoLabel ? `${acaoLabel.toLowerCase()}.` : ".");
    const verboFirst = {
      presenca_sessao:   "Registrar a primeira",
      avaliacao_sessao:  "Avaliar a primeira",
      pergunta_valida:   "Enviar a primeira",
      completude_perfil: "Completar o perfil pela primeira vez.",
      conexao_aceita:    "Realizar a primeira",
      visita_estande:    "Visitar o primeiro",
      resgate_realizado: "Realizar o primeiro",
    }[acao_referencia];
    if (acao_referencia === "completude_perfil") return verboFirst;
    return `${verboFirst || "Realizar a primeira"} ${sufixos[acao_referencia] || "."}`;
  }

  if (criterio_tipo === "percent" && acao_referencia) {
    if (acao_referencia === "completude_perfil") return `Completar pelo menos ${meta}% do perfil.`;
    if (acao_referencia === "visita_estande") return `Visitar pelo menos ${meta}% dos estandes.`;
    return `Atingir ${meta}% em ${acaoLabel ? acaoLabel.toLowerCase() : "ação"}.`;
  }

  if (criterio_tipo === "count" && acao_referencia) {
    const verbo = verbos[acao_referencia] || "Realizar pelo menos";
    const sufixo = sufixos[acao_referencia] || ".";
    return `${verbo} ${meta} ${sufixo}`;
  }

  return "";
}

// ── Badge Card ────────────────────────────────────────────────────────────────
function BadgeCard({ badge, hasAccess, onEdit, onToggle, onDelete }) {
  const catColors = CAT_COLORS[badge.categoria] || {};
  const descricao = gerarDescricao(badge.criterio_tipo, badge.acao_referencia, badge.valor_meta);

  return (
    <div className={`relative rounded-xl border ${catColors.border || "border-border"} ${badge.ativo ? (catColors.bg || "bg-card") : "bg-muted/30"} p-3 flex flex-col items-center gap-1.5 min-h-[120px] transition-all`}>
      {/* Ícone */}
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center text-2xl shrink-0 transition-all"
        style={{
          backgroundColor: badge.ativo ? (badge.icone_cor || "#6366f1") + "22" : "#e5e7eb",
          filter: badge.ativo ? "none" : "grayscale(1)",
        }}
      >
        {badge.icone_emoji || "🏅"}
      </div>

      {/* Título */}
      <p className={`text-xs font-medium text-center leading-tight ${badge.ativo ? "text-foreground" : "text-muted-foreground"}`}>
        {badge.titulo}
      </p>

      {/* Descrição automática */}
      {descricao && (
        <p className="text-[10px] text-center leading-snug text-muted-foreground/80 px-1">
          {descricao}
        </p>
      )}

      {/* Menu kebab */}
      {hasAccess && (
        <div className="absolute top-1 right-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-6 w-6 opacity-60 hover:opacity-100">
                <MoreVertical className="w-3 h-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit(badge)}>
                <Pencil className="w-3.5 h-3.5 mr-2" /> Editar
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onToggle(badge)}>
                {badge.ativo
                  ? <><ToggleLeft className="w-3.5 h-3.5 mr-2" /> Desativar</>
                  : <><ToggleRight className="w-3.5 h-3.5 mr-2" /> Ativar</>}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onDelete(badge)} className="text-destructive focus:text-destructive">
                <Trash2 className="w-3.5 h-3.5 mr-2" /> Excluir badge
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

// ── Empty Cell ────────────────────────────────────────────────────────────────
function EmptyCell({ hasAccess, onAdd }) {
  return (
    <div
      className={`rounded-xl border-2 border-dashed border-border min-h-[120px] flex items-center justify-center ${hasAccess ? "cursor-pointer hover:border-primary hover:bg-muted/20 transition-all" : ""}`}
      onClick={hasAccess ? onAdd : undefined}
    >
      {hasAccess && <span className="text-2xl text-muted-foreground/40">+</span>}
    </div>
  );
}

// ── Form Dialog ───────────────────────────────────────────────────────────────
function BadgeForm({ badge, eventId, existingPositions, existingCodigos, onSubmit, onClose, isSubmitting }) {
  const [form, setForm] = useState({
    codigo: badge?.codigo ?? "",
    titulo: badge?.titulo ?? "",
    icone_emoji: badge?.icone_emoji ?? "🏅",
    icone_cor: badge?.icone_cor ?? "#6366f1",
    categoria: badge?.categoria ?? "",
    coluna_progresso: badge?.coluna_progresso ?? "",
    criterio_tipo: badge?.criterio_tipo ?? "first",
    acao_referencia: badge?.acao_referencia ?? "",
    valor_meta: badge?.valor_meta ?? 1,
    ativo: badge?.ativo ?? true,
  });
  const [errors, setErrors] = useState({});

  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const currentCat = form.categoria || "engajamento";
  const sugestoes = ICONE_SUGESTOES[currentCat] || ICONE_SUGESTOES.engajamento;

  // Descrição dinâmica no formulário
  const previewDescricao = gerarDescricao(form.criterio_tipo, form.acao_referencia || null, form.valor_meta);

  const validate = () => {
    const errs = {};
    if (!form.codigo.trim()) errs.codigo = "Código obrigatório.";
    else if (!badge && existingCodigos.includes(form.codigo.trim().toUpperCase()))
      errs.codigo = "Código já existe neste evento.";
    if (!form.titulo.trim()) errs.titulo = "Título obrigatório.";
    if (!form.categoria) errs.categoria = "Categoria obrigatória.";
    if (!form.coluna_progresso) errs.coluna_progresso = "Coluna obrigatória.";
    if (!badge) {
      const pos = `${form.categoria}__${form.coluna_progresso}`;
      if (existingPositions.includes(pos)) errs.coluna_progresso = "Já existe uma badge nesta posição.";
    }
    if (!form.criterio_tipo) errs.criterio_tipo = "Critério obrigatório.";
    const meta = Number(form.valor_meta);
    if (form.criterio_tipo === "first" && meta !== 1) errs.valor_meta = "Para 'first', meta deve ser 1.";
    if (form.criterio_tipo === "count" && (!Number.isInteger(meta) || meta < 1)) errs.valor_meta = "Mínimo 1.";
    if (form.criterio_tipo === "percent" && (meta < 1 || meta > 100)) errs.valor_meta = "Entre 1 e 100.";
    if (form.criterio_tipo === "points_total" && (meta < 100 || meta % 100 !== 0)) errs.valor_meta = "Mínimo 100, múltiplo de 100.";
    return errs;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }
    onSubmit({
      codigo: form.codigo.trim().toUpperCase(),
      titulo: form.titulo.trim(),
      icone_emoji: form.icone_emoji,
      icone_cor: form.icone_cor,
      categoria: form.categoria,
      coluna_progresso: form.coluna_progresso,
      criterio_tipo: form.criterio_tipo,
      acao_referencia: form.criterio_tipo === "points_total" ? null : (form.acao_referencia || null),
      valor_meta: Number(form.valor_meta),
      ativo: form.ativo,
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{badge ? "Editar Badge" : "Nova Badge"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Ícone */}
          <div className="space-y-1.5">
            <Label>Ícone</Label>
            <div className="flex flex-wrap gap-2 mb-2">
              {sugestoes.map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => set("icone_emoji", em)}
                  className={`w-9 h-9 rounded-lg text-xl flex items-center justify-center transition-all border-2 ${form.icone_emoji === em ? "border-primary bg-primary/10 scale-110" : "border-transparent hover:border-muted"}`}
                >
                  {em}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center text-2xl" style={{ backgroundColor: form.icone_cor + "22" }}>
                {form.icone_emoji}
              </div>
              <div className="flex-1 space-y-1">
                <Label className="text-xs text-muted-foreground">Emoji personalizado</Label>
                <Input value={form.icone_emoji} onChange={(e) => set("icone_emoji", e.target.value)} className="h-8 text-lg w-20" maxLength={2} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Cor</Label>
                <input type="color" value={form.icone_cor} onChange={(e) => set("icone_cor", e.target.value)} className="h-8 w-16 rounded cursor-pointer border border-border" />
              </div>
            </div>
          </div>

          {/* Código + Título */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>Código *</Label>
              <Input value={form.codigo} onChange={(e) => set("codigo", e.target.value)} disabled={!!badge} placeholder="1A" className="uppercase" />
              {errors.codigo && <p className="text-xs text-destructive">{errors.codigo}</p>}
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label>Título *</Label>
              <Input value={form.titulo} onChange={(e) => set("titulo", e.target.value)} />
              {errors.titulo && <p className="text-xs text-destructive">{errors.titulo}</p>}
            </div>
          </div>

          {/* Categoria + Coluna */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Categoria *</Label>
              <Select value={form.categoria} onValueChange={(v) => set("categoria", v)} disabled={!!badge}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {CATEGORIAS.map((c) => <SelectItem key={c} value={c}>{CAT_LABELS[c]}</SelectItem>)}
                </SelectContent>
              </Select>
              {errors.categoria && <p className="text-xs text-destructive">{errors.categoria}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Coluna *</Label>
              <Select value={form.coluna_progresso} onValueChange={(v) => set("coluna_progresso", v)} disabled={!!badge}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {COLUNAS.map((c) => <SelectItem key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</SelectItem>)}
                </SelectContent>
              </Select>
              {errors.coluna_progresso && <p className="text-xs text-destructive">{errors.coluna_progresso}</p>}
            </div>
          </div>

          {/* Critério + Meta */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Critério *</Label>
              <Select value={form.criterio_tipo} onValueChange={(v) => {
                set("criterio_tipo", v);
                if (v === "first") set("valor_meta", 1);
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CRITERIO_LABELS).map(([k, lbl]) => <SelectItem key={k} value={k}>{lbl}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Meta *</Label>
              <Input
                type="number"
                min={form.criterio_tipo === "points_total" ? 100 : 1}
                step={form.criterio_tipo === "points_total" ? 100 : 1}
                max={form.criterio_tipo === "percent" ? 100 : undefined}
                value={form.valor_meta}
                onChange={(e) => set("valor_meta", e.target.value)}
                disabled={form.criterio_tipo === "first"}
              />
              {errors.valor_meta && <p className="text-xs text-destructive">{errors.valor_meta}</p>}
            </div>
          </div>

          {/* Ação referência */}
          {form.criterio_tipo !== "points_total" && (
            <div className="space-y-1.5">
              <Label>Ação de Referência</Label>
              <Select
                value={form.acao_referencia || "__none__"}
                onValueChange={(v) => set("acao_referencia", v === "__none__" ? "" : v)}
              >
                <SelectTrigger><SelectValue placeholder="— nenhuma —" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— nenhuma —</SelectItem>
                  {ACAO_EVENTO_KEYS.map((k) => <SelectItem key={k} value={k}>{ACAO_EVENTO_LABELS[k]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Preview de descrição automática */}
          {previewDescricao && (
            <div className="rounded-lg bg-muted/50 border border-border px-3 py-2">
              <p className="text-xs text-muted-foreground font-medium mb-0.5">Descrição gerada automaticamente:</p>
              <p className="text-xs text-foreground">{previewDescricao}</p>
            </div>
          )}

          {/* Ativo */}
          <div className="flex items-center gap-3">
            <Switch checked={form.ativo} onCheckedChange={(v) => set("ativo", v)} id="badge-ativo" />
            <Label htmlFor="badge-ativo">Badge ativa</Label>
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
export default function ConquistasTab({ eventId, hasAccess, user }) {
  const queryClient = useQueryClient();
  const [formBadge, setFormBadge] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formPreset, setFormPreset] = useState({});

  const { data: badges = [], isLoading } = useQuery({
    queryKey: ["badges", eventId],
    queryFn: () => base44.entities.Badge.filter({ event_id: eventId, is_deleted: false }),
  });

  const saveMut = useMutation({
    mutationFn: async ({ data, id }) => {
      if (id) {
        await base44.entities.Badge.update(id, data);
        return { id, action: "update" };
      } else {
        const created = await base44.entities.Badge.create({ ...data, event_id: eventId, is_deleted: false });
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
    mutationFn: ({ id, ativo }) => base44.entities.Badge.update(id, { ativo }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["badges", eventId] }),
    onError: (err) => toast.error(err.message || "Erro."),
  });

  const deleteMut = useMutation({
    mutationFn: ({ id }) => base44.entities.Badge.update(id, { is_deleted: true }),
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
        toCreate.map((d) => base44.entities.Badge.create({ ...d, event_id: eventId, is_deleted: false, ativo: true }))
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
    Promise.all(targets.map((b) => base44.entities.Badge.update(b.id, { ativo }))).then(() => {
      queryClient.invalidateQueries({ queryKey: ["badges", eventId] });
      toast.success(`${ativo ? "Ativadas" : "Desativadas"} ${targets.length} badges de ${CAT_LABELS[categoria]}.`);
    });
  };

  // Toggle por coluna
  const toggleColuna = (coluna, ativo) => {
    const targets = badges.filter((b) => b.coluna_progresso === coluna);
    if (targets.length === 0) return;
    Promise.all(targets.map((b) => base44.entities.Badge.update(b.id, { ativo }))).then(() => {
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
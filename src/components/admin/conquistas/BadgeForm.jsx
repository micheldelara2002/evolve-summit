/**
 * Formulário de criação/edição de badge da matriz de conquistas: ícone
 * (sugestões por categoria + custom), código, título, categoria, coluna,
 * critério/meta, ação de referência e preview da descrição automática.
 */
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ACAO_EVENTO_LABELS, ACAO_EVENTO_KEYS } from "@/lib/acaoEvento";
import {
  COLUNAS, CATEGORIAS, CAT_LABELS, CRITERIO_LABELS, ICONE_SUGESTOES, gerarDescricao,
} from "@/components/admin/conquistas/badgeModel";

export default function BadgeForm({ badge, eventId, existingPositions, existingCodigos, onSubmit, onClose, isSubmitting }) {
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
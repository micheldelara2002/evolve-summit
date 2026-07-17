import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { logAudit } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, MoreVertical, Pencil, Trash2, ToggleLeft, ToggleRight, ImageIcon, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { sanitizeText } from "@/utils/sanitize";
import { uploadFile } from "@/lib/apiClient";

const PAGE_SIZE = 10;

// ── Lê estoque_total ───────────
const getEstoqueTotal = (item) => item?.estoque_total ?? 0;
const getEstoqueDisponivel = (item) =>
  Math.max(0, getEstoqueTotal(item) - (item?.quantidade_resgatada ?? 0));

// ── Upload de imagem ───────────────────────────────────────────────────────────
function ImageUpload({ value, onChange }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const { file_url } = await uploadFile(file);
      onChange(file_url);
    } catch (err) {
      toast.error("Erro ao fazer upload da imagem.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      {value ? (
        <div className="relative inline-block">
          <img src={value} alt="preview" className="w-24 h-24 rounded-lg object-cover border border-border" />
          <button
            type="button"
            onClick={() => onChange(null)}
            className="absolute -top-1.5 -right-1.5 bg-destructive text-white rounded-full w-5 h-5 flex items-center justify-center"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex flex-col items-center justify-center w-24 h-24 rounded-lg border-2 border-dashed border-border hover:border-primary hover:bg-muted/40 transition-colors text-muted-foreground"
        >
          {uploading ? (
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <Upload className="w-5 h-5 mb-1" />
              <span className="text-[10px]">Enviar</span>
            </>
          )}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
    </div>
  );
}

// ── Placeholder de imagem ──────────────────────────────────────────────────────
function ItemImage({ src, size = "sm" }) {
  const cls = size === "sm" ? "w-8 h-8" : "w-16 h-16";
  if (src) {
    return <img src={src} alt="" className={`${cls} rounded object-cover shrink-0 border border-border`} />;
  }
  return (
    <div className={`${cls} rounded bg-muted flex items-center justify-center shrink-0 border border-border`}>
      <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
    </div>
  );
}

// ── Form Dialog ───────────────────────────────────────────────────────────────
function StoreItemForm({ item, existingCodes, onSubmit, onClose, isSubmitting }) {
  const [form, setForm] = useState({
    codigo_item: item?.codigo_item ?? "",
    descricao_item: item?.descricao_item ?? "",
    imagem_url: item?.imagem_url ?? null,
    pontos_necessarios: item?.pontos_necessarios ?? "",
    estoque_total: getEstoqueTotal(item) !== 0 || item ? getEstoqueTotal(item) : "",
    limite_por_usuario: item?.limite_por_usuario ?? "",
    status: item?.status ?? "ativo",
  });
  const [errors, setErrors] = useState({});

  const update = (key, val) => setForm((p) => ({ ...p, [key]: val }));

  const validate = () => {
    const errs = {};
    if (!form.codigo_item.trim()) errs.codigo_item = "Código obrigatório.";
    else if (!item && existingCodes.includes(form.codigo_item.trim().toLowerCase()))
      errs.codigo_item = "Já existe um item com este código neste evento.";
    if (!form.descricao_item.trim()) errs.descricao_item = "Descrição obrigatória.";
    const pts = Number(form.pontos_necessarios);
    if (form.pontos_necessarios === "" || isNaN(pts) || !Number.isInteger(pts) || pts <= 0)
      errs.pontos_necessarios = "Informe um inteiro maior que 0.";
    const est = Number(form.estoque_total);
    if (form.estoque_total === "" || isNaN(est) || !Number.isInteger(est) || est < 0)
      errs.estoque_total = "Informe um inteiro maior ou igual a 0.";
    const lim = Number(form.limite_por_usuario);
    if (form.limite_por_usuario === "" || isNaN(lim) || !Number.isInteger(lim) || lim < 1)
      errs.limite_por_usuario = "Informe um inteiro maior ou igual a 1.";
    return errs;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) { setErrors(errs); return; }
    onSubmit({
      codigo_item: sanitizeText(form.codigo_item.trim()),
      descricao_item: sanitizeText(form.descricao_item.trim()),
      imagem_url: form.imagem_url || null,
      pontos_necessarios: Number(form.pontos_necessarios),
      estoque_total: Number(form.estoque_total),
      limite_por_usuario: Number(form.limite_por_usuario),
      status: form.status,
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display">{item ? "Editar Item" : "Novo Item da Loja"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Imagem */}
          <div className="space-y-1.5">
            <Label>Imagem do Item</Label>
            <ImageUpload value={form.imagem_url} onChange={(v) => update("imagem_url", v)} />
          </div>

          {/* Código */}
          <div className="space-y-1.5">
            <Label>Código do Item *</Label>
            <Input value={form.codigo_item} onChange={(e) => update("codigo_item", e.target.value)} disabled={!!item} />
            {errors.codigo_item && <p className="text-xs text-destructive">{errors.codigo_item}</p>}
          </div>

          {/* Descrição */}
          <div className="space-y-1.5">
            <Label>Descrição *</Label>
            <Input value={form.descricao_item} onChange={(e) => update("descricao_item", e.target.value)} />
            {errors.descricao_item && <p className="text-xs text-destructive">{errors.descricao_item}</p>}
          </div>

          {/* Pontos + Estoque Total */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Pontos Necessários *</Label>
              <Input type="number" min={1} step={1} value={form.pontos_necessarios} onChange={(e) => update("pontos_necessarios", e.target.value)} />
              {errors.pontos_necessarios && <p className="text-xs text-destructive">{errors.pontos_necessarios}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Estoque Total *</Label>
              <Input type="number" min={0} step={1} value={form.estoque_total} onChange={(e) => update("estoque_total", e.target.value)} />
              {errors.estoque_total && <p className="text-xs text-destructive">{errors.estoque_total}</p>}
            </div>
          </div>

          {/* Limite e Status */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Limite por Usuário *</Label>
              <Input type="number" min={1} step={1} value={form.limite_por_usuario} onChange={(e) => update("limite_por_usuario", e.target.value)} />
              {errors.limite_por_usuario && <p className="text-xs text-destructive">{errors.limite_por_usuario}</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Status *</Label>
              <Select value={form.status} onValueChange={(v) => update("status", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ativo">Ativo</SelectItem>
                  <SelectItem value="inativo">Inativo</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
export default function LojaTab({ eventId, hasAccess, user }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [formItem, setFormItem] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["store-items", eventId],
    queryFn: () => base44.entities.StoreItem.filter({ event_id: eventId, is_deleted: false }),
  });

  const saveMut = useMutation({
    mutationFn: async ({ data, id }) => {
      if (id) {
        await base44.entities.StoreItem.update(id, data);
        return { id, action: "update" };
      } else {
        const created = await base44.entities.StoreItem.create({
          ...data,
          event_id: eventId,
          is_deleted: false,
          quantidade_resgatada: 0,
        });
        return { id: created.id, action: "create" };
      }
    },
    onSuccess: ({ id, action }) => {
      logAudit({ event_id: eventId, action, entity_type: "StoreItem", entity_id: id, user });
      queryClient.invalidateQueries({ queryKey: ["store-items", eventId] });
      setFormOpen(false);
      toast.success("Salvo com sucesso.");
    },
    onError: (err) => toast.error(err.message || "Erro ao salvar."),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => base44.entities.StoreItem.update(id, { is_deleted: true }),
    onSuccess: (_, id) => {
      logAudit({ event_id: eventId, action: "soft_delete", entity_type: "StoreItem", entity_id: id, user });
      queryClient.invalidateQueries({ queryKey: ["store-items", eventId] });
      setDeleteTarget(null);
      toast.success("Item removido.");
    },
    onError: (err) => toast.error(err.message || "Erro ao excluir."),
  });

  const toggleStatus = (item) => {
    const newStatus = item.status === "ativo" ? "inativo" : "ativo";
    saveMut.mutate({ data: { status: newStatus }, id: item.id });
  };

  const filtered = items.filter((it) => {
    const q = search.toLowerCase();
    return (it.codigo_item || "").toLowerCase().includes(q) || (it.descricao_item || "").toLowerCase().includes(q);
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const existingCodes = items.map((it) => it.codigo_item?.toLowerCase());

  const openNew = () => { setFormItem(null); setFormOpen(true); };
  const openEdit = (item) => { setFormItem(item); setFormOpen(true); };

  return (
    <div className="space-y-4">
      {/* Barra de ações */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por código ou descrição..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9 h-9"
          />
        </div>
        {hasAccess && (
          <Button size="sm" className="gap-1 shrink-0" onClick={openNew}>
            <Plus className="w-4 h-4" /> Novo Item
          </Button>
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
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground w-10"></th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Código</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Descrição</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-right">Pontos</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-right">Est. Total</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-right">Est. Disponível</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground text-right">Lim./Usuário</th>
                  <th className="px-3 py-2.5 text-xs font-semibold text-muted-foreground">Status</th>
                  {hasAccess && <th className="px-3 py-2.5 w-10" />}
                </tr>
              </thead>
              <tbody>
                {paginated.map((item, idx) => (
                  <tr key={item.id} className={`border-t border-border ${idx % 2 === 0 ? "bg-card" : "bg-muted/20"} hover:bg-muted/40 transition-colors`}>
                    <td className="px-3 py-2">
                      <ItemImage src={item.imagem_url} size="sm" />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs font-medium">{item.codigo_item}</td>
                    <td className="px-3 py-2.5 text-sm max-w-[180px] truncate">{item.descricao_item}</td>
                    <td className="px-3 py-2.5 text-right text-xs">{item.pontos_necessarios}</td>
                    <td className="px-3 py-2.5 text-right text-xs">{getEstoqueTotal(item)}</td>
                    <td className="px-3 py-2.5 text-right text-xs font-medium">
                      <span className={getEstoqueDisponivel(item) === 0 ? "text-destructive" : "text-secondary"}>
                        {getEstoqueDisponivel(item)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs">{item.limite_por_usuario}</td>
                    <td className="px-3 py-2.5">
                      <Badge className={item.status === "ativo" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}>
                        {item.status === "ativo" ? "Ativo" : "Inativo"}
                      </Badge>
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
                            <DropdownMenuItem onClick={() => openEdit(item)}>
                              <Pencil className="w-4 h-4 mr-2" /> Editar
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => toggleStatus(item)}>
                              {item.status === "ativo"
                                ? <><ToggleLeft className="w-4 h-4 mr-2" /> Desativar</>
                                : <><ToggleRight className="w-4 h-4 mr-2" /> Ativar</>
                              }
                            </DropdownMenuItem>
                            <DropdownMenuItem className="text-destructive" onClick={() => setDeleteTarget(item)}>
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
            <p className="text-center text-muted-foreground py-8 text-sm">Nenhum item cadastrado.</p>
          )}
        </div>
      )}

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-1">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>Anterior</Button>
          <span className="text-xs text-muted-foreground">Página {page} de {totalPages}</span>
          <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(page + 1)}>Próxima</Button>
        </div>
      )}

      {/* Form Dialog */}
      {formOpen && (
        <StoreItemForm
          item={formItem}
          existingCodes={existingCodes}
          onSubmit={(data) => saveMut.mutate({ data, id: formItem?.id })}
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
              Deseja excluir o item <strong>{deleteTarget?.codigo_item}</strong> — {deleteTarget?.descricao_item}?
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
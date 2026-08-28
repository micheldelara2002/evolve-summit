import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Ticket, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { listCommerce, createCommerce, updateCommerce, deleteCommerce } from "@/lib/commerceApi";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import EntityFormDialog from "@/components/admin/EntityFormDialog";

export default function TicketTypesLotsTab({ eventId, hasAccess }) {
  const qc = useQueryClient();
  const [typeDialog, setTypeDialog] = useState(null); // null | { mode, data }
  const [lotDialog, setLotDialog] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const { data: types = [], isLoading: loadingTypes } = useQuery({
    queryKey: ["commerce", "TicketType", eventId],
    queryFn: () => listCommerce("TicketType", eventId),
  });
  const { data: lots = [] } = useQuery({
    queryKey: ["commerce", "SalesLot", eventId],
    queryFn: () => listCommerce("SalesLot", eventId),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["commerce", "TicketType", eventId] });
    qc.invalidateQueries({ queryKey: ["commerce", "SalesLot", eventId] });
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteCommerce(deleteTarget.entity, eventId, deleteTarget.id);
    setDeleteTarget(null);
    invalidate();
  };

  if (!hasAccess) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Sem permissão para gerenciar ingressos.</p>;
  }

  return (
    <div className="space-y-6">
      {/* ===== Ticket Types ===== */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Ticket className="w-4 h-4 text-primary" /> Tipos de Ingresso</h3>
          <Button size="sm" onClick={() => setTypeDialog({ mode: "create", data: {} })}>
            <Plus className="w-4 h-4" /> Novo tipo
          </Button>
        </div>
        {loadingTypes ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : types.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center bg-card rounded-xl border border-dashed border-border">
            Nenhum tipo de ingresso criado.
          </p>
        ) : (
          <div className="space-y-2">
            {types.map((tt) => (
              <div key={tt.id} className="flex items-start gap-3 p-3 rounded-xl bg-card border border-border">
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{tt.name}</p>
                  {tt.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{tt.description}</p>}
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {lots.filter((l) => l.ticket_type_id === tt.id).length} lote(s) · {tt.is_active ? "Ativo" : "Inativo"}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" onClick={() => setTypeDialog({ mode: "edit", data: tt })}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button size="icon" variant="ghost" onClick={() => setDeleteTarget({ entity: "TicketType", id: tt.id })}>
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ===== Sales Lots ===== */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Layers className="w-4 h-4 text-primary" /> Lotes de Venda</h3>
          <Button size="sm" onClick={() => setLotDialog({ mode: "create", data: {} })} disabled={types.length === 0}>
            <Plus className="w-4 h-4" /> Novo lote
          </Button>
        </div>
        {types.length > 0 && lots.length === 0 && (
          <p className="text-sm text-muted-foreground py-6 text-center bg-card rounded-xl border border-dashed border-border">
            Nenhum lote criado. Crie um lote para definir preço e janela de venda.
          </p>
        )}
        <div className="space-y-2">
          {lots.map((lot) => {
            const tt = types.find((t) => t.id === lot.ticket_type_id);
            const remaining = (lot.quantity_total || 0) - (lot.quantity_reserved || 0) - (lot.quantity_sold || 0);
            return (
              <div key={lot.id} className="p-3 rounded-xl bg-card border border-border space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-sm">{lot.name}</p>
                    <p className="text-[11px] text-muted-foreground">{tt?.name || "—"}</p>
                  </div>
                  <p className="font-display font-bold text-primary text-lg">R$ {Number(lot.price).toFixed(2)}</p>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>Vendidos: {lot.quantity_sold || 0}</span>
                  <span>Reservados: {lot.quantity_reserved || 0}</span>
                  <span>Disponíveis: {remaining}</span>
                  <span>Total: {lot.quantity_total || 0}</span>
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Venda: {lot.sale_start ? new Date(lot.sale_start).toLocaleDateString("pt-BR") : "—"} → {lot.sale_end ? new Date(lot.sale_end).toLocaleDateString("pt-BR") : "—"}
                </div>
                <div className="flex gap-1 pt-1">
                  <Button size="sm" variant="outline" onClick={() => setLotDialog({ mode: "edit", data: lot })}>
                    <Pencil className="w-3.5 h-3.5" /> Editar
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleteTarget({ entity: "SalesLot", id: lot.id })}>
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ===== Ticket Type dialog ===== */}
      {typeDialog && (
        <TicketTypeDialog
          eventId={eventId}
          mode={typeDialog.mode}
          data={typeDialog.data}
          onClose={() => setTypeDialog(null)}
          onSaved={() => { setTypeDialog(null); invalidate(); }}
        />
      )}
      {/* ===== Lot dialog ===== */}
      {lotDialog && (
        <LotDialog
          eventId={eventId}
          types={types}
          mode={lotDialog.mode}
          data={lotDialog.data}
          onClose={() => setLotDialog(null)}
          onSaved={() => { setLotDialog(null); invalidate(); }}
        />
      )}

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Excluir"
        description="Tem certeza que deseja excluir este item? Esta ação não pode ser desfeita."
      />
    </div>
  );
}

function TicketTypeDialog({ eventId, mode, data, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: data.name || "",
    description: data.description || "",
    sort_order: data.sort_order || 0,
    is_active: data.is_active !== false,
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (mode === "create") await createCommerce("TicketType", eventId, form);
      else await updateCommerce("TicketType", eventId, data.id, form);
      onSaved();
    } catch (e) {
      setSaving(false);
    }
  };

  return (
    <EntityFormDialog open onClose={onClose} title={mode === "create" ? "Novo tipo de ingresso" : "Editar tipo"} onSave={submit} saving={saving}>
      <div className="space-y-3">
        <div>
          <Label>Nome</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex: Inteira, Meia, VIP" />
        </div>
        <div>
          <Label>Descrição (benefícios)</Label>
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} id="tt-active" />
          <Label htmlFor="tt-active" className="cursor-pointer">Ativo</Label>
        </div>
      </div>
    </EntityFormDialog>
  );
}

function LotDialog({ eventId, types, mode, data, onClose, onSaved }) {
  const [form, setForm] = useState({
    ticket_type_id: data.ticket_type_id || types[0]?.id || "",
    name: data.name || "",
    price: data.price ?? 0,
    sale_start: data.sale_start ? data.sale_start.slice(0, 16) : "",
    sale_end: data.sale_end ? data.sale_end.slice(0, 16) : "",
    quantity_total: data.quantity_total ?? 0,
    is_active: data.is_active !== false,
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.ticket_type_id || !form.name.trim()) return;
    setSaving(true);
    const payload = {
      ...form,
      price: Number(form.price),
      quantity_total: Number(form.quantity_total),
      sale_start: form.sale_start ? new Date(form.sale_start).toISOString() : "",
      sale_end: form.sale_end ? new Date(form.sale_end).toISOString() : "",
    };
    try {
      if (mode === "create") await createCommerce("SalesLot", eventId, payload);
      else await updateCommerce("SalesLot", eventId, data.id, payload);
      onSaved();
    } catch (e) {
      setSaving(false);
    }
  };

  return (
    <EntityFormDialog open onClose={onClose} title={mode === "create" ? "Novo lote" : "Editar lote"} onSave={submit} saving={saving}>
      <div className="space-y-3">
        <div>
          <Label>Tipo de ingresso</Label>
          <select
            value={form.ticket_type_id}
            onChange={(e) => setForm({ ...form, ticket_type_id: e.target.value })}
            className="w-full h-9 rounded-md bg-background border border-input px-2 text-sm"
          >
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <Label>Nome do lote</Label>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex: 1º Lote" />
        </div>
        <div>
          <Label>Preço (R$)</Label>
          <Input type="number" step="0.01" min="0" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Início da venda</Label>
            <Input type="datetime-local" value={form.sale_start} onChange={(e) => setForm({ ...form, sale_start: e.target.value })} />
          </div>
          <div>
            <Label>Fim da venda</Label>
            <Input type="datetime-local" value={form.sale_end} onChange={(e) => setForm({ ...form, sale_end: e.target.value })} />
          </div>
        </div>
        <div>
          <Label>Quantidade total</Label>
          <Input type="number" min="0" value={form.quantity_total} onChange={(e) => setForm({ ...form, quantity_total: e.target.value })} />
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} id="lot-active" />
          <Label htmlFor="lot-active" className="cursor-pointer">Ativo</Label>
        </div>
      </div>
    </EntityFormDialog>
  );
}
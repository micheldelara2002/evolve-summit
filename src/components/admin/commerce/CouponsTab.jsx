import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { listCommerce, createCommerce, updateCommerce, deleteCommerce } from "@/lib/commerceApi";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import CommerceFormDialog from "./CommerceFormDialog";

export default function CouponsTab({ eventId, hasAccess }) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const { data: coupons = [], isLoading } = useQuery({
    queryKey: ["commerce", "Coupon", eventId],
    queryFn: () => listCommerce("Coupon", eventId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["commerce", "Coupon", eventId] });

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await deleteCommerce("Coupon", eventId, deleteTarget);
    setDeleteTarget(null);
    invalidate();
  };

  if (!hasAccess) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Sem permissão.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Tag className="w-4 h-4 text-primary" /> Cupons de Desconto</h3>
        <Button size="sm" onClick={() => setDialog({ mode: "create", data: {} })}>
          <Plus className="w-4 h-4" /> Novo cupom
        </Button>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : coupons.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center bg-card rounded-xl border border-dashed border-border">
          Nenhum cupom criado.
        </p>
      ) : (
        <div className="space-y-2">
          {coupons.map((c) => (
            <div key={c.id} className="flex items-start gap-3 p-3 rounded-xl bg-card border border-border">
              <div className="flex-1 min-w-0">
                <p className="font-mono font-semibold text-sm">{c.code}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {c.discount_type === "percent" ? `${c.value}% off` : `R$ ${Number(c.value).toFixed(2)} off`} · {c.scope === "per_ticket" ? "por ingresso" : "no carrinho"}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Usos: {c.uses_count || 0}{c.max_uses > 0 ? `/${c.max_uses}` : "/∞"} · {c.is_active ? "Ativo" : "Inativo"}
                </p>
              </div>
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" onClick={() => setDialog({ mode: "edit", data: c })}>
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => setDeleteTarget(c.id)}>
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {dialog && (
        <CouponDialog eventId={eventId} mode={dialog.mode} data={dialog.data} onClose={() => setDialog(null)} onSaved={() => { setDialog(null); invalidate(); }} />
      )}
      <ConfirmDeleteDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)} onConfirm={handleDelete} title="Excluir cupom" description="Tem certeza que deseja excluir este cupom?" />
    </div>
  );
}

function CouponDialog({ eventId, mode, data, onClose, onSaved }) {
  const [form, setForm] = useState({
    code: data.code || "",
    discount_type: data.discount_type || "percent",
    value: data.value ?? 10,
    scope: data.scope || "per_ticket",
    valid_from: data.valid_from ? data.valid_from.slice(0, 16) : "",
    valid_to: data.valid_to ? data.valid_to.slice(0, 16) : "",
    max_uses: data.max_uses ?? 0,
    is_active: data.is_active !== false,
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!form.code.trim()) return;
    setSaving(true);
    const payload = {
      ...form,
      value: Number(form.value),
      max_uses: Number(form.max_uses),
      valid_from: form.valid_from ? new Date(form.valid_from).toISOString() : "",
      valid_to: form.valid_to ? new Date(form.valid_to).toISOString() : "",
    };
    try {
      if (mode === "create") await createCommerce("Coupon", eventId, payload);
      else await updateCommerce("Coupon", eventId, data.id, payload);
      onSaved();
    } catch (e) {
      setSaving(false);
    }
  };

  return (
    <CommerceFormDialog open onClose={onClose} title={mode === "create" ? "Novo cupom" : "Editar cupom"} onSave={submit} saving={saving}>
      <div className="space-y-3">
        <div>
          <Label>Código</Label>
          <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="EX: PROMO10" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Tipo de desconto</Label>
            <select value={form.discount_type} onChange={(e) => setForm({ ...form, discount_type: e.target.value })} className="w-full h-9 rounded-md bg-background border border-input px-2 text-sm">
              <option value="percent">Percentual (%)</option>
              <option value="fixed">Valor fixo (R$)</option>
            </select>
          </div>
          <div>
            <Label>Valor</Label>
            <Input type="number" step="0.01" min="0" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </div>
        </div>
        <div>
          <Label>Escopo</Label>
          <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} className="w-full h-9 rounded-md bg-background border border-input px-2 text-sm">
            <option value="per_ticket">Por ingresso</option>
            <option value="per_cart">No carrinho todo</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Válido de</Label>
            <Input type="datetime-local" value={form.valid_from} onChange={(e) => setForm({ ...form, valid_from: e.target.value })} />
          </div>
          <div>
            <Label>Válido até</Label>
            <Input type="datetime-local" value={form.valid_to} onChange={(e) => setForm({ ...form, valid_to: e.target.value })} />
          </div>
        </div>
        <div>
          <Label>Máximo de usos (0 = ilimitado)</Label>
          <Input type="number" min="0" value={form.max_uses} onChange={(e) => setForm({ ...form, max_uses: e.target.value })} />
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} id="cp-active" />
          <Label htmlFor="cp-active" className="cursor-pointer">Ativo</Label>
        </div>
      </div>
    </CommerceFormDialog>
  );
}
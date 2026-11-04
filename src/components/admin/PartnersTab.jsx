import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Building2, Plus, Search, MoreVertical, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import AssociatePartnerModal from "@/components/admin/partners/AssociatePartnerModal";

const PLAN_LABELS = {
  diamante: "Diamante",
  ouro: "Ouro",
  prata: "Prata",
  bronze: "Bronze",
  apoiador: "Apoiador",
};

const PLAN_COLORS = {
  diamante: "bg-cyan-100 text-cyan-800 border-cyan-300",
  ouro: "bg-yellow-100 text-yellow-800 border-yellow-300",
  prata: "bg-slate-100 text-slate-700 border-slate-300",
  bronze: "bg-orange-100 text-orange-800 border-orange-300",
  apoiador: "bg-purple-100 text-purple-800 border-purple-300",
};

function EditEventPartnerModal({ eventPartner, partnerName, eventId, onClose, onSaved }) {
  const [plan, setPlan] = useState(eventPartner.sponsorship_plan || "apoiador");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await base44.functions.invoke("associateEventPartner", {
        action: "update_plan",
        eventId,
        eventPartnerId: eventPartner.id,
        sponsorshipPlan: plan,
      });
      onSaved();
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Editar plano — {partnerName}</DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-2">
          <Label className="text-xs">Plano de patrocínio *</Label>
          <div className="flex flex-wrap gap-2">
            {Object.entries(PLAN_LABELS).map(([val, lbl]) => (
              <button
                key={val}
                type="button"
                onClick={() => setPlan(val)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                  plan === val
                    ? PLAN_COLORS[val] + " ring-2 ring-offset-1 ring-primary"
                    : "bg-muted/40 text-muted-foreground border-border hover:bg-muted"
                }`}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function PartnersTab({ eventId, hasAccess }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [associating, setAssociating] = useState(false);
  const [editingEP, setEditingEP] = useState(null);

  const { data: eventPartners = [], isLoading: isLoadingEP } = useQuery({
    queryKey: ["event_partners", eventId],
    queryFn: () => base44.entities.EventPartner.filter({ event_id: eventId, is_deleted: false }),
  });

  const partnerIds = [...new Set(eventPartners.map((ep) => ep.partner_id))].filter(Boolean);
  const { data: partners = [], isLoading: isLoadingPartners } = useQuery({
    queryKey: ["partners_by_ids", partnerIds.join(",")],
    queryFn: () =>
      partnerIds.length
        ? base44.entities.Partner.filter({ id: { $in: partnerIds } })
        : Promise.resolve([]),
    enabled: partnerIds.length > 0,
  });

  const partnerMap = Object.fromEntries(partners.map((p) => [p.id, p]));
  const isLoading = isLoadingEP || (partnerIds.length > 0 && isLoadingPartners);

  const handleRemove = async (ep) => {
    try {
      await base44.functions.invoke("associateEventPartner", {
        action: "unlink",
        eventId,
        eventPartnerId: ep.id,
      });
      queryClient.invalidateQueries({ queryKey: ["event_partners", eventId] });
      toast.success("Parceiro desassociado.");
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message);
    }
  };

  const onSaved = () => {
    queryClient.invalidateQueries({ queryKey: ["event_partners", eventId] });
    queryClient.invalidateQueries({ queryKey: ["participants", eventId] });
    setAssociating(false);
    setEditingEP(null);
    toast.success("Parceiro vinculado ao evento.");
  };

  const filtered = eventPartners.filter((ep) => {
    const p = partnerMap[ep.partner_id];
    if (!p) return false;
    const q = search.toLowerCase();
    return !q || p.trade_name?.toLowerCase().includes(q) || p.legal_name?.toLowerCase().includes(q);
  });

  const planOrder = ["diamante", "ouro", "prata", "bronze", "apoiador"];
  const sorted = [...filtered].sort(
    (a, b) => planOrder.indexOf(a.sponsorship_plan) - planOrder.indexOf(b.sponsorship_plan)
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar parceiro..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        {hasAccess && (
          <Button size="sm" className="gap-1 shrink-0" onClick={() => setAssociating(true)}>
            <Plus className="w-4 h-4" /> Vincular
          </Button>
        )}
      </div>

      {isLoading && (
        <div className="flex justify-center py-8">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!isLoading && sorted.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
          <Building2 className="w-8 h-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground max-w-xs">
            Nenhum parceiro vinculado.{" "}
            {hasAccess && (
              <button className="underline text-primary" onClick={() => setAssociating(true)}>
                Buscar no catálogo global
              </button>
            )}
          </p>
        </div>
      )}

      {sorted.map((ep) => {
        const partner = partnerMap[ep.partner_id];
        if (!partner) return null;
        return (
          <div key={ep.id} className="flex items-center gap-3 p-3 rounded-xl border border-border bg-card">
            <div className="w-9 h-9 rounded-lg border border-border bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden">
              {partner.logo_url
                ? <img src={partner.logo_url} alt={partner.trade_name} className="w-full h-full object-contain" />
                : <Building2 className="w-4 h-4 text-muted-foreground/40" />}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium truncate">{partner.trade_name}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${PLAN_COLORS[ep.sponsorship_plan] || "bg-muted text-muted-foreground"}`}>
                  {PLAN_LABELS[ep.sponsorship_plan] || ep.sponsorship_plan}
                </span>
                {partner.identity_mode === "informal" && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full border border-border text-muted-foreground">
                    sem documento
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">{partner.legal_name}</p>
            </div>

            {hasAccess && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-11 w-11 sm:h-8 sm:w-8 shrink-0">
                    <MoreVertical className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditingEP(ep)}>
                    <Pencil className="w-4 h-4 mr-2" /> Editar plano
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-destructive" onClick={() => handleRemove(ep)}>
                    <Trash2 className="w-4 h-4 mr-2" /> Desassociar
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        );
      })}

      {associating && (
        <AssociatePartnerModal
          eventId={eventId}
          existingEventPartners={eventPartners}
          onClose={() => setAssociating(false)}
          onSaved={onSaved}
        />
      )}

      {editingEP && (
        <EditEventPartnerModal
          eventPartner={editingEP}
          partnerName={partnerMap[editingEP.partner_id]?.trade_name ?? ""}
          eventId={eventId}
          onClose={() => setEditingEP(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ["event_partners", eventId] });
            setEditingEP(null);
            toast.success("Plano atualizado.");
          }}
        />
      )}
    </div>
  );
}
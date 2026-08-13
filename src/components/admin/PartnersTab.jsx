import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Building2, Plus, Search, MoreVertical, Pencil, Trash2, Star,
} from "lucide-react";
import { toast } from "sonner";
import { incParticipantCounter } from "@/lib/businessCounters";

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

// ─── Associate Modal ─────────────────────────────────────────────────────────
function AssociatePartnerModal({ eventId, existingEventPartners = [], onClose, onSaved }) {
  const [selectedPartnerId, setSelectedPartnerId] = useState("");
  const [plan, setPlan] = useState("apoiador");
  const [selectedRepIds, setSelectedRepIds] = useState([]);
  const [partnerSearch, setPartnerSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // All global partners (active, not deleted)
  const { data: allPartners = [] } = useQuery({
    queryKey: ["global_partners_for_assoc"],
    queryFn: () => base44.entities.Partner.list("-created_date", 500),
  });

  // Global reps for selected partner
  const { data: globalReps = [] } = useQuery({
    queryKey: ["global_reps_for_partner", selectedPartnerId],
    queryFn: () =>
      base44.entities.PartnerRepresentative.filter({
        partner_id: selectedPartnerId,
        is_deleted: false,
        is_active: true,
      }),
    enabled: !!selectedPartnerId,
  });

  // Persons for rep display
  const { data: allPersons = [] } = useQuery({
    queryKey: ["persons_mini"],
    queryFn: () => base44.entities.Person.list("-full_name", 300),
  });

  const personMap = Object.fromEntries(allPersons.map((p) => [p.id, p]));

  // Filter out already-associated partners
  const alreadyAssociated = new Set(existingEventPartners.map((ep) => ep.partner_id));
  const availablePartners = allPartners.filter(
    (p) => !p.is_deleted && p.is_active !== false && !alreadyAssociated.has(p.id)
  );

  const filteredPartners = availablePartners.filter((p) => {
    const q = partnerSearch.toLowerCase();
    return !q || p.trade_name?.toLowerCase().includes(q) || p.legal_name?.toLowerCase().includes(q);
  });

  const toggleRep = (repId) => {
    setSelectedRepIds((prev) =>
      prev.includes(repId) ? prev.filter((id) => id !== repId) : [...prev, repId]
    );
  };

  const handleSave = async () => {
    if (!selectedPartnerId) { toast.error("Selecione uma empresa."); return; }

    setSaving(true);
    try {
      // 1. Create EventPartner association
      await base44.entities.EventPartner.create({
        event_id: eventId,
        partner_id: selectedPartnerId,
        sponsorship_plan: plan,
        is_active: true,
        is_deleted: false,
      });

      // 2. Upsert participants for selected reps
      if (selectedRepIds.length > 0) {
        // Load existing participants for this event
        const existingParticipants = await base44.entities.Participant.filter({
          event_id: eventId,
          is_deleted: false,
        });

        for (const repId of selectedRepIds) {
          const rep = globalReps.find((r) => r.id === repId);
          if (!rep) continue;
          const person = personMap[rep.person_id];
          if (!person) continue;

          const email = person.contact_email || "";
          // Check duplicate by person_id or email
          const existing = existingParticipants.find(
            (p) =>
              (p.person_id && p.person_id === rep.person_id) ||
              (email && p.email === email)
          );

          const payload = {
            event_id: eventId,
            full_name: person.full_name,
            email: email,
            phone: person.phone || "",
            company: person.company || "",
            job_title: person.job_title || "",
            bio: person.bio || "",
            linkedin: person.linkedin || "",
            photo_url: person.photo_url || "",
            role_in_event: "partner_rep",
            registration_status: "confirmed",
            person_id: rep.person_id,
            is_deleted: false,
          };

          if (existing) {
            await base44.entities.Participant.update(existing.id, {
              role_in_event: "partner_rep",
              person_id: rep.person_id,
            });
          } else {
            const created = await base44.entities.Participant.create(payload);
            await incParticipantCounter(eventId, created?.created_date, "partner_rep");
          }
        }
      }

      onSaved();
    } catch (err) {
      toast.error("Erro ao associar: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Associar Parceiro ao Evento</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Partner search + select */}
          <div className="space-y-1">
            <Label className="text-xs">Empresa *</Label>
            <Input
              placeholder="Buscar empresa..."
              value={partnerSearch}
              onChange={(e) => { setPartnerSearch(e.target.value); setSelectedPartnerId(""); }}
              className="mb-1"
            />
            <select
              className="w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm"
              value={selectedPartnerId}
              onChange={(e) => { setSelectedPartnerId(e.target.value); setSelectedRepIds([]); }}
            >
              <option value="">Selecione uma empresa...</option>
              {filteredPartners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.trade_name} ({p.legal_document_type}: {p.legal_document_number})
                </option>
              ))}
            </select>
            {availablePartners.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Todos os parceiros globais já estão associados a este evento.
              </p>
            )}
          </div>

          {/* Plan */}
          <div className="space-y-1">
            <Label className="text-xs">Plano de Patrocínio *</Label>
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

          {/* Reps */}
          {selectedPartnerId && (
            <div className="space-y-1">
              <Label className="text-xs">
                Representantes para este evento
                <span className="text-muted-foreground ml-1">(opcional — viram Participant)</span>
              </Label>
              {globalReps.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">
                  Nenhum representante ativo cadastrado para esta empresa.
                </p>
              ) : (
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {globalReps.map((rep) => {
                    const person = personMap[rep.person_id];
                    const selected = selectedRepIds.includes(rep.id);
                    return (
                      <label
                        key={rep.id}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                          selected ? "bg-primary/5 border-primary/30" : "border-border hover:bg-muted/30"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleRep(rep.id)}
                          className="accent-primary"
                        />
                        <div className="text-sm min-w-0">
                          <div className="font-medium truncate">{person?.full_name ?? rep.person_id}</div>
                          <div className="text-xs text-muted-foreground">
                            {person?.contact_email ?? "—"} · {rep.role_in_partner === "partner_manager" ? "Gestor" : "Representante"}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || !selectedPartnerId}>
            {saving ? "Salvando..." : "Associar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit Modal (plan only) ───────────────────────────────────────────────────
function EditEventPartnerModal({ eventPartner, partnerName, onClose, onSaved }) {
  const [plan, setPlan] = useState(eventPartner.sponsorship_plan || "apoiador");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await base44.entities.EventPartner.update(eventPartner.id, { sponsorship_plan: plan });
    onSaved();
    setSaving(false);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Editar Plano — {partnerName}</DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-2">
          <Label className="text-xs">Plano de Patrocínio *</Label>
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

// ─── Main Tab Component ───────────────────────────────────────────────────────
export default function PartnersTab({ eventId, hasAccess }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [associating, setAssociating] = useState(false);
  const [editingEP, setEditingEP] = useState(null);

  const { data: eventPartners = [], isLoading } = useQuery({
    queryKey: ["event_partners", eventId],
    queryFn: () => base44.entities.EventPartner.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: allPartners = [] } = useQuery({
    queryKey: ["global_partners_for_assoc"],
    queryFn: () => base44.entities.Partner.list("-created_date", 500),
  });

  const partnerMap = Object.fromEntries(allPartners.map((p) => [p.id, p]));

  const handleRemove = async (ep) => {
    await base44.entities.EventPartner.update(ep.id, { is_deleted: true });
    queryClient.invalidateQueries({ queryKey: ["event_partners", eventId] });
    toast.success("Parceiro desassociado.");
  };

  const onSaved = () => {
    queryClient.invalidateQueries({ queryKey: ["event_partners", eventId] });
    queryClient.invalidateQueries({ queryKey: ["participants", eventId] });
    setAssociating(false);
    setEditingEP(null);
    toast.success("Parceiro associado com sucesso.");
  };

  const filtered = eventPartners.filter((ep) => {
    const p = partnerMap[ep.partner_id];
    if (!p) return false;
    const q = search.toLowerCase();
    return !q || p.trade_name?.toLowerCase().includes(q) || p.legal_name?.toLowerCase().includes(q);
  });

  // Sort by plan weight
  const planOrder = ["diamante", "ouro", "prata", "bronze", "apoiador"];
  const sorted = [...filtered].sort(
    (a, b) => planOrder.indexOf(a.sponsorship_plan) - planOrder.indexOf(b.sponsorship_plan)
  );

  return (
    <div className="space-y-3">
      {/* Toolbar */}
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
            <Plus className="w-4 h-4" /> Associar
          </Button>
        )}
      </div>

      {/* List */}
      {isLoading && (
        <div className="flex justify-center py-8">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {!isLoading && sorted.length === 0 && (
        <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
          <Building2 className="w-8 h-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            Nenhum parceiro associado.{" "}
            {hasAccess && (
              <button className="underline text-primary" onClick={() => setAssociating(true)}>
                Associar agora
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
            {/* Logo */}
            <div className="w-9 h-9 rounded-lg border border-border bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden">
              {partner.logo_url
                ? <img src={partner.logo_url} alt={partner.trade_name} className="w-full h-full object-contain" />
                : <Building2 className="w-4 h-4 text-muted-foreground/40" />
              }
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium truncate">{partner.trade_name}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-semibold ${PLAN_COLORS[ep.sponsorship_plan] || "bg-muted text-muted-foreground"}`}>
                  {PLAN_LABELS[ep.sponsorship_plan] || ep.sponsorship_plan}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">{partner.legal_name}</p>
            </div>

            {hasAccess && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
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

      {/* Modals */}
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
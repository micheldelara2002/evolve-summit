import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Building2, Search, Plus, Check } from "lucide-react";
import { toast } from "sonner";
import PartnerFormDialog from "@/components/admin/partners/PartnerFormDialog";

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

/**
 * Vincula um parceiro GLOBAL já existente ao evento (ou cadastra um novo,
 * passando pela checagem de duplicidade). Busca pelo backend: o catálogo de
 * parceiros é global e o gerente do evento não o lê diretamente.
 */
export default function AssociatePartnerModal({ eventId, existingEventPartners = [], onClose, onSaved }) {
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [selected, setSelected] = useState(null);
  const [plan, setPlan] = useState("apoiador");
  const [selectedRepIds, setSelectedRepIds] = useState([]);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newRepEmail, setNewRepEmail] = useState("");
  const [newRepName, setNewRepName] = useState("");
  const [addingRep, setAddingRep] = useState(false);

  const alreadyAssociated = new Set(existingEventPartners.map((ep) => ep.partner_id));

  const { data: results = [], isFetching } = useQuery({
    queryKey: ["partner_search", submitted],
    queryFn: async () => {
      const res = await base44.functions.invoke("searchPartners", { query: submitted });
      return res.data?.partners || [];
    },
    enabled: submitted.trim().length >= 2,
  });

  const { data: reps = [], refetch: refetchReps } = useQuery({
    queryKey: ["partner_reps_for_assoc", selected?.id],
    queryFn: async () => {
      const res = await base44.functions.invoke("getPartnerRepresentatives", {
        partnerId: selected.id,
        eventId,
      });
      return res.data?.representatives || [];
    },
    enabled: !!selected?.id,
  });

  const available = results.filter((p) => !alreadyAssociated.has(p.id));
  // Representante sem conta ainda não pode representar a empresa no evento.
  const selectableReps = reps.filter((r) => r.access_status !== "pending");

  const handleSave = async () => {
    if (!selected) { toast.error("Selecione um parceiro."); return; }
    setSaving(true);
    try {
      const res = await base44.functions.invoke("associateEventPartner", {
        eventId,
        partnerId: selected.id,
        sponsorshipPlan: plan,
        repIds: selectedRepIds,
      });
      if (res.data?.error) throw new Error(res.data.error);
      onSaved();
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message || "Não foi possível associar.");
    } finally {
      setSaving(false);
    }
  };

  const pickPartner = (partner) => {
    setSelected(partner);
    setSelectedRepIds([]);
    setCreating(false);
    setNewRepEmail("");
    setNewRepName("");
  };

  // Gerente do evento também cadastra representantes do parceiro vinculado.
  // Sem conta no app, o convite é enviado e o vínculo fica pendente.
  const addRepresentative = async () => {
    const email = newRepEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      toast.error("Informe um e-mail válido.");
      return;
    }
    setAddingRep(true);
    try {
      const res = await base44.functions.invoke("savePartnerRep", {
        partnerId: selected.id,
        eventId,
        email,
        name: newRepName.trim(),
        roleInPartner: "representative",
        isActive: true,
      });
      const out = res.data || {};
      if (out.status === "pending") {
        if (out.invited) toast.success("Convite de cadastro enviado. O vínculo se completa quando a conta for criada.");
        else toast.warning(`Vínculo pendente, mas o convite não foi enviado${out.invite_error ? `: ${out.invite_error}` : "."}`);
      } else {
        toast.success("Representante cadastrado.");
      }
      setNewRepEmail("");
      setNewRepName("");
      refetchReps();
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message || "Não foi possível cadastrar o representante.");
    } finally {
      setAddingRep(false);
    }
  };

  if (creating) {
    return (
      <PartnerFormDialog
        onClose={() => setCreating(false)}
        onSaved={() => setCreating(false)}
        onPickExisting={(candidate) => pickPartner(candidate)}
      />
    );
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Vincular parceiro ao evento</DialogTitle>
          <DialogDescription>
            O parceiro é global. Busque antes de cadastrar para não duplicar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1">
            <Label className="text-xs">Buscar parceiro</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Nome, CNPJ ou e-mail..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setSubmitted(e.target.value); }}
                className="pl-9"
                autoFocus
              />
            </div>
            <p className="text-[11px] text-muted-foreground">Digite ao menos 2 letras.</p>
          </div>

          {isFetching && (
            <div className="flex justify-center py-4">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {!isFetching && submitted.trim().length >= 2 && available.length === 0 && (
            <div className="text-center py-3 space-y-2">
              <p className="text-sm text-muted-foreground">Nenhum parceiro encontrado.</p>
              <Button size="sm" variant="outline" className="gap-1" onClick={() => setCreating(true)}>
                <Plus className="w-3.5 h-3.5" /> Cadastrar “{search.trim()}”
              </Button>
            </div>
          )}

          <div className="space-y-1.5">
            {available.map((p) => {
              const active = selected?.id === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickPartner(p)}
                  className={`w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-colors ${
                    active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"
                  }`}
                >
                  <div className="w-8 h-8 rounded-lg border border-border bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden">
                    {p.logo_url
                      ? <img src={p.logo_url} alt="" className="w-full h-full object-contain" />
                      : <Building2 className="w-4 h-4 text-muted-foreground/40" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{p.trade_name}</div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      {p.identity_mode === "informal" ? "Sem documento" : `${p.legal_document_type} ${p.legal_document_number}`}
                      {p.event_count ? ` · ${p.event_count} evento(s)` : " · novo no app"}
                    </div>
                  </div>
                  {active && <Check className="w-4 h-4 text-primary shrink-0" />}
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="space-y-3 border-t border-border pt-3">
              <div className="space-y-1.5 rounded-xl border border-dashed border-border p-2.5">
                <Label className="text-xs">Cadastrar representante por e-mail</Label>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="email"
                    placeholder="e-mail"
                    value={newRepEmail}
                    onChange={(e) => setNewRepEmail(e.target.value)}
                    className="flex-1 h-8 text-sm"
                  />
                  <Input
                    placeholder="nome (opcional)"
                    value={newRepName}
                    onChange={(e) => setNewRepName(e.target.value)}
                    className="flex-1 h-8 text-sm"
                  />
                  <Button size="sm" variant="outline" onClick={addRepresentative} disabled={addingRep || !newRepEmail.trim()}>
                    {addingRep ? "..." : "Adicionar"}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Se a pessoa ainda não tem conta no app, enviamos o convite e o vínculo fica pendente.
                </p>
              </div>

              <div className="space-y-1">
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

              <div className="space-y-1">
                <Label className="text-xs">
                  Representantes neste evento
                  <span className="text-muted-foreground ml-1">(opcional — viram Participant)</span>
                </Label>
                {selectableReps.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-1">
                    Nenhum representante com conta ativa cadastrado para esta empresa.
                  </p>
                ) : (
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {selectableReps.map((rep) => {
                      const checked = selectedRepIds.includes(rep.id);
                      return (
                        <label
                          key={rep.id}
                          className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                            checked ? "bg-primary/5 border-primary/30" : "border-border hover:bg-muted/30"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => setSelectedRepIds((prev) =>
                              prev.includes(rep.id) ? prev.filter((id) => id !== rep.id) : [...prev, rep.id])}
                            className="accent-primary"
                          />
                          <div className="text-sm min-w-0">
                            <div className="font-medium truncate">{rep.full_name || rep.person_id}</div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {rep.contact_email || "—"} · {rep.role_in_partner === "partner_manager" ? "Gestor" : "Representante"}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setCreating(true)} disabled={saving} className="mr-auto gap-1">
            <Plus className="w-3.5 h-3.5" /> Novo parceiro
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || !selected}>
            {saving ? "Salvando..." : "Vincular"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
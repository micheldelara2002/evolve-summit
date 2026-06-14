/**
 * Aba associativa de Representantes de Parceiros.
 * Vínculo: participante + evento + parceiro (obrigatório).
 * Não permite criar novo representante sem selecionar um parceiro.
 */
import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { t } from "@/lib/i18n";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/AuthContext";
import { logAudit } from "@/lib/audit";

export default function AssociativeRepTab({ eventId, participants, partners, reps, hasAccess }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [linkDialog, setLinkDialog] = useState(false);
  const [selectedPartnerId, setSelectedPartnerId] = useState("");
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [saving, setSaving] = useState(false);

  const partnerName = (id) => partners.find((p) => p.id === id)?.name || "—";
  const participantName = (id) => participants.find((p) => p.id === id)?.full_name || "—";

  const filteredReps = reps.filter(
    (r) =>
      (r.full_name || participantName(r.participant_id) || "").toLowerCase().includes(search.toLowerCase()) ||
      partnerName(r.partner_id).toLowerCase().includes(search.toLowerCase())
  );

  const handleLink = async () => {
    if (!selectedPartnerId || !selectedParticipantId) {
      toast.error("Selecione o parceiro e o participante");
      return;
    }
    setSaving(true);
    const participant = participants.find((p) => p.id === selectedParticipantId);
    const rep = await base44.entities.PartnerRepresentative.create({
      event_id: eventId,
      partner_id: selectedPartnerId,
      full_name: participant?.full_name || "",
      email: participant?.email || "",
      phone: participant?.phone || "",
      is_deleted: false,
    });
    logAudit({ event_id: eventId, action: "create", entity_type: "PartnerRepresentative", entity_id: rep.id, user });
    queryClient.invalidateQueries({ queryKey: ["reps", eventId] });
    setSaving(false);
    setLinkDialog(false);
    setSelectedPartnerId("");
    setSelectedParticipantId("");
    toast.success(t("events.saveSuccess"));
  };

  const handleRemove = async (rep) => {
    await base44.entities.PartnerRepresentative.update(rep.id, { is_deleted: true });
    logAudit({ event_id: eventId, action: "soft_delete", entity_type: "PartnerRepresentative", entity_id: rep.id, user });
    queryClient.invalidateQueries({ queryKey: ["reps", eventId] });
    toast.success(t("events.deleteSuccess"));
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Vincule participantes como representantes de parceiros. Vínculo obrigatório: participante + parceiro.
      </p>

      <div className="flex gap-2">
        <input
          className="flex h-9 flex-1 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="Buscar..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {hasAccess && (
          <Button size="sm" onClick={() => setLinkDialog(true)} disabled={partners.length === 0 || participants.length === 0}>
            + Vincular
          </Button>
        )}
      </div>

      {partners.length === 0 && (
        <p className="text-xs text-amber-600 bg-amber-50 rounded-lg p-3">
          Cadastre ao menos um parceiro na aba Parceiros antes de vincular representantes.
        </p>
      )}

      <div className="space-y-2">
        {filteredReps.map((rep) => (
          <div key={rep.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-border bg-card">
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{rep.full_name || "—"}</p>
              <p className="text-xs text-muted-foreground truncate">{rep.email} · {partnerName(rep.partner_id)}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge variant="secondary" className="text-xs">{partnerName(rep.partner_id)}</Badge>
              {hasAccess && (
                <Button variant="ghost" size="sm" className="text-xs h-7 text-destructive hover:text-destructive" onClick={() => handleRemove(rep)}>
                  Remover
                </Button>
              )}
            </div>
          </div>
        ))}
        {filteredReps.length === 0 && (
          <p className="text-center text-muted-foreground py-6 text-sm">{t("common.noData")}</p>
        )}
      </div>

      {/* Link Dialog */}
      <Dialog open={linkDialog} onOpenChange={setLinkDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display">Vincular Representante</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Parceiro *</Label>
              <Select value={selectedPartnerId} onValueChange={setSelectedPartnerId}>
                <SelectTrigger><SelectValue placeholder="Selecionar parceiro" /></SelectTrigger>
                <SelectContent>
                  {partners.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Participante *</Label>
              <Select value={selectedParticipantId} onValueChange={setSelectedParticipantId}>
                <SelectTrigger><SelectValue placeholder="Selecionar participante" /></SelectTrigger>
                <SelectContent>
                  {participants.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.full_name} · {p.email}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLinkDialog(false)}>{t("common.cancel")}</Button>
            <Button onClick={handleLink} disabled={saving || !selectedPartnerId || !selectedParticipantId}>
              {saving ? t("common.loading") : "Vincular"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
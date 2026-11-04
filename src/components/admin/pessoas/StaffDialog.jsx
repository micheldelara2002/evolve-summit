/**
 * Equipe do evento (staff).
 * Regra (2026-11-04): staff precisa de conta (User) + Person. Quem já tem conta
 * é associado na hora e vira participante; quem não tem recebe convite de
 * cadastro e o vínculo fica pendente até o primeiro acesso.
 * Só admin ou o GERENTE do evento gerencia a equipe — 'team' não se descadastra
 * nem cadastra outros membros (o servidor recusa).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Users, UserPlus, Mail, X, Trash2 } from "lucide-react";
import { toast } from "sonner";
import ConfirmDeleteDialog from "@/components/ui/ConfirmDeleteDialog";
import { getEventStaff, assignEventStaff, removeEventStaff } from "@/lib/participantApi";

export default function StaffDialog({ eventId, onClose, onChanged }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["event-staff", eventId],
    queryFn: () => getEventStaff(eventId),
  });

  const staff = data?.participants || [];
  const pending = data?.invites || [];

  const refresh = () => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ["participants", eventId] });
    onChanged?.();
  };

  const handleAdd = async () => {
    const value = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      toast.error("Informe um e-mail válido.");
      return;
    }
    setSaving(true);
    try {
      const res = await assignEventStaff(eventId, { email: value, full_name: name.trim() });
      if (res.status === "linked") {
        toast.success("Pessoa adicionada à equipe do evento.");
      } else if (res.invite?.invited) {
        toast.success(`Convite de cadastro enviado para ${value}. O vínculo se completa quando a conta for criada.`);
      } else {
        toast.warning(`Convite não enviado${res.invite?.error ? `: ${res.invite.error}` : "."} Reenvie mais tarde.`);
      }
      setEmail("");
      setName("");
      refresh();
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message || "Não foi possível adicionar à equipe.");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (target) => {
    try {
      await removeEventStaff(eventId, { participantId: target.participantId, email: target.email });
      toast.success("Removido da equipe.");
      setRemoveTarget(null);
      refresh();
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message || "Não foi possível remover.");
    }
  };

  const handleRevokeInvite = async (invite) => {
    try {
      await base44.functions.invoke("manageEventInvite", {
        action: "revoke",
        eventId,
        inviteId: invite.id,
      });
      toast.success("Convite cancelado.");
      refresh();
    } catch (err) {
      toast.error(err?.response?.data?.error || err.message || "Não foi possível cancelar o convite.");
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-4 h-4" /> Equipe do evento
          </DialogTitle>
          <DialogDescription>
            Só quem tem conta no app pode fazer parte da equipe. Sem conta, enviamos o convite de cadastro.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {isLoading ? (
            <div className="flex justify-center py-6">
              <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">Equipe ativa ({staff.length})</Label>
                {staff.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-1">Nenhum membro na equipe.</p>
                ) : (
                  <div className="space-y-1">
                    {staff.map((m) => (
                      <div key={m.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{m.full_name || m.email}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{m.email || "sem e-mail"}</p>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="w-7 h-7 text-destructive shrink-0"
                          title="Remover da equipe"
                          onClick={() => setRemoveTarget({ participantId: m.id, email: m.email, name: m.full_name })}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {pending.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Convites pendentes ({pending.length})</Label>
                  <div className="space-y-1">
                    {pending.map((inv) => (
                      <div key={inv.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate flex items-center gap-1.5">
                            <Mail className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                            {inv.invited_name || inv.email}
                          </p>
                          <p className="text-[11px] text-amber-700 truncate">
                            {inv.invite_error
                              ? `Convite não enviado: ${inv.invite_error}`
                              : `Aguardando cadastro — ${inv.email}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Badge variant="outline" className="text-[10px] py-0 border-amber-300 text-amber-700">Pendente</Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="w-7 h-7 text-muted-foreground"
                            title="Cancelar convite"
                            onClick={() => handleRevokeInvite(inv)}
                          >
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2 rounded-xl border border-border bg-muted/25 p-3">
                <Label className="text-xs">Adicionar à equipe</Label>
                <Input
                  placeholder="E-mail da pessoa"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Input
                  placeholder="Nome (opcional)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Button className="w-full gap-1.5" onClick={handleAdd} disabled={saving || !email.trim()}>
                  <UserPlus className="w-4 h-4" />
                  {saving ? "Verificando conta..." : "Adicionar"}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Se a pessoa já usa o app, entra na hora. Se não, o convite é enviado e o vínculo fica pendente.
                </p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
        </DialogFooter>

        <ConfirmDeleteDialog
          open={!!removeTarget}
          onOpenChange={() => setRemoveTarget(null)}
          title="Remover da equipe?"
          description={`${removeTarget?.name || removeTarget?.email || ""} perde o acesso de equipe a este evento. A presença como participante é mantida.`}
          confirmLabel="Remover"
          onConfirm={() => handleRemove(removeTarget)}
        />
      </DialogContent>
    </Dialog>
  );
}
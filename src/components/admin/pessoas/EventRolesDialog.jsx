/**
 * Curadores e avaliadores do evento (EventMembership).
 *
 * Regra (2026-11-06): curador/avaliador precisa de CONTA (User) + Person. Quem
 * já usa o app é vinculado na hora; quem não usa recebe convite de cadastro e o
 * vínculo nasce no primeiro acesso. Só admin ou o GERENTE do evento concede e
 * revoga — o servidor recusa qualquer outro papel.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ShieldCheck, UserPlus, Mail, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  listEventRoles, grantEventRole, revokeEventRole, eventRoleErrorMessage,
} from "@/lib/eventRoleApi";

const ROLE_LABELS = { curator: "Curador", reviewer: "Avaliador" };
const ROLE_HINT = {
  curator: "Revisa e decide as submissões de Call for Papers.",
  reviewer: "Avalia os cases das premiações em que for designado à banca.",
};

export default function EventRolesDialog({ eventId, onClose, onChanged }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState("reviewer");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["event-roles", eventId],
    queryFn: () => listEventRoles(eventId),
  });

  const memberships = data?.memberships || [];
  const invites = data?.invites || [];

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["event-roles", eventId] });
    queryClient.invalidateQueries({ queryKey: ["event-reviewers", eventId] });
    onChanged?.();
  };

  const handleGrant = async () => {
    const value = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      toast.error("Informe um e-mail válido.");
      return;
    }
    setSaving(true);
    try {
      const res = await grantEventRole({ eventId, role, email: value, fullName: name.trim() });
      if (res.status === "linked") {
        toast.success(`${ROLE_LABELS[role]} vinculado ao evento.`);
      } else if (res.invite?.invited) {
        toast.success(
          `Convite de cadastro enviado para ${value}. O papel é ativado automaticamente quando a conta for criada.`
        );
      } else {
        toast.warning(
          `Convite não enviado${res.invite?.error ? `: ${res.invite.error}` : "."} Reenvie mais tarde.`
        );
      }
      setEmail("");
      setName("");
      refresh();
    } catch (err) {
      toast.error(eventRoleErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (target) => {
    try {
      await revokeEventRole({
        eventId,
        role: target.role,
        membershipId: target.membershipId,
        inviteId: target.inviteId,
      });
      toast.success(
        target.inviteId ? "Convite cancelado." : `${ROLE_LABELS[target.role]} removido do evento.`
      );
      refresh();
    } catch (err) {
      toast.error(eventRoleErrorMessage(err));
    }
  };

  const renderRoleSection = (roleKey) => {
    const people = memberships.filter((m) => m.role === roleKey);
    const pending = invites.filter((i) => i.role === roleKey);
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            {ROLE_LABELS[roleKey]}es ({people.length})
          </Label>
          {pending.length > 0 && (
            <Badge variant="outline" className="text-[10px]">{pending.length} pendente(s)</Badge>
          )}
        </div>

        {people.length === 0 && pending.length === 0 ? (
          <p className="text-xs text-muted-foreground py-1">Ninguém neste papel ainda.</p>
        ) : (
          <div className="space-y-1">
            {people.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-border">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{m.person_name || m.user_email}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{m.user_email || "sem e-mail"}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="w-7 h-7 text-destructive shrink-0"
                  title={`Remover ${ROLE_LABELS[roleKey].toLowerCase()}`}
                  onClick={() => handleRevoke({ role: roleKey, membershipId: m.id })}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
            {pending.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-warning/40 bg-warning/10">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 shrink-0" />
                    {inv.invited_name || inv.email}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {inv.invite_error ? `Convite não enviado: ${inv.invite_error}` : `Aguardando cadastro — ${inv.email}`}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Badge variant="outline" className="text-[10px] py-0">Pendente</Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="w-7 h-7 text-muted-foreground"
                    title="Cancelar convite"
                    onClick={() => handleRevoke({ role: roleKey, inviteId: inv.id })}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> Curadoria e avaliação
          </DialogTitle>
          <DialogDescription>
            Curador e avaliador precisam de conta no app. Sem conta, enviamos o convite de cadastro e o papel
            é ativado automaticamente no primeiro acesso da pessoa.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-6">
            <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-5 py-1">
            {renderRoleSection("curator")}
            {renderRoleSection("reviewer")}

            <div className="space-y-2 rounded-xl border border-border bg-muted/25 p-3">
              <Label className="text-xs">Adicionar ao evento</Label>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="reviewer">Avaliador</SelectItem>
                  <SelectItem value="curator">Curador</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">{ROLE_HINT[role]}</p>
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
              <Button className="w-full gap-1.5" onClick={handleGrant} disabled={saving || !email.trim()}>
                <UserPlus className="w-4 h-4" />
                {saving ? "Verificando conta..." : `Adicionar ${ROLE_LABELS[role].toLowerCase()}`}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
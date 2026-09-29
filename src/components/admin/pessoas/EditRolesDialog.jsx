/**
 * Editar papéis do participante no evento.
 * Papel no Participant (speaker/team/manager/attendee) + avaliador via
 * EventMembership (independente do role_in_event).
 * partner_rep NÃO é atribuído aqui (gerenciado na aba Parceiros).
 */
import { useState, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { getDisabledRoles } from "@/components/admin/pessoas/roleConstants";
import {
  updateParticipant,
  getReviewerMembership,
  setReviewerMembership,
} from "@/lib/participantApi";
import { moveParticipantRoleCounter } from "@/lib/businessCounters";
import { logAudit } from "@/lib/audit";

const ROLE_OPTIONS = [
  { value: "speaker",  label: "Palestrante" },
  { value: "team",     label: "Equipe" },
  { value: "manager",  label: "Gerente" },
  { value: "reviewer",  label: "Avaliador" },
];

export default function EditRolesDialog({ pessoa, eventId, sessions = [], user, onClose, onSuccess }) {
  const isPartnerRep = pessoa.role_in_event === "partner_rep";

  const [roles, setRoles] = useState(() => {
    if (isPartnerRep) return []; // managed elsewhere
    const r = [];
    if (["speaker", "team", "manager"].includes(pessoa.role_in_event)) r.push(pessoa.role_in_event);
    return r;
  });
  const [isReviewer, setIsReviewer] = useState(false);
  const [reviewerMembership, setReviewerMembershipState] = useState(null);
  const [reviewerUserId, setReviewerUserId] = useState("");
  const [checkingReviewer, setCheckingReviewer] = useState(!isPartnerRep && !!pessoa.person_id);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(null);
  const queryClient = useQueryClient();

  const disabledRoles = useMemo(() => getDisabledRoles(roles), [roles]);

  // Resolve existing reviewer membership + linked user_id (by email)
  useEffect(() => {
    if (isPartnerRep || !pessoa.person_id) { setCheckingReviewer(false); return; }
    (async () => {
      try {
        const res = await getReviewerMembership(eventId, pessoa.person_id);
        if (res.membership) { setReviewerMembershipState(res.membership); setIsReviewer(true); }
        setReviewerUserId(res.linked_user_id);
      } finally { setCheckingReviewer(false); }
    })();
  }, [isPartnerRep, pessoa.person_id, pessoa.email, eventId]);

  const toggleRole = (role) => {
    setConflict(null);
    if (role === "reviewer") { setIsReviewer((v) => !v); return; }
    if (roles.includes(role)) {
      setRoles((prev) => prev.filter((r) => r !== role));
    } else if (!disabledRoles.has(role)) {
      setRoles((prev) => [...prev, role]);
    }
  };

  const handleSave = async () => {
    // Block remove speaker if person has sessions
    if (pessoa.role_in_event === "speaker" && !roles.includes("speaker")) {
      const hasSessions = sessions.some((s) => s.speaker_id === pessoa.id);
      if (hasSessions) {
        setConflict("Não é possível alterar o papel: esta pessoa possui sessão associada. Edite a sessão primeiro.");
        return;
      }
    }

    setSaving(true);
    try {
      // Papel no Participant (speaker/team/manager/attendee)
      let newRole = "attendee";
      if (roles.includes("manager")) newRole = "manager";
      else if (roles.includes("speaker")) newRole = "speaker";
      else if (roles.includes("team")) newRole = "team";
      if (newRole !== pessoa.role_in_event) {
        await updateParticipant(eventId, pessoa.id, { role_in_event: newRole });
        // P0.3 — move o bucket participants_by_role do papel antigo para o novo (unique não muda)
        await moveParticipantRoleCounter(eventId, pessoa.created_date, pessoa.role_in_event, newRole);
        logAudit({ event_id: eventId, action: "role_change", entity_type: "Participant", entity_id: pessoa.id, user,
          details: { field: "role_in_event", old_value: pessoa.role_in_event, new_value: newRole } });
      }

      // Avaliador — gerenciado via EventMembership (independente do role_in_event)
      if (!pessoa.person_id && isReviewer) {
        setConflict("Esta pessoa não tem perfil global (Person) vinculado; não é possível designá-la como avaliadora.");
        setSaving(false);
        return;
      }
      if (isReviewer && !reviewerMembership) {
        await setReviewerMembership(eventId, {
          enable: true,
          person_id: pessoa.person_id,
          person_name: pessoa.full_name,
          user_email: pessoa.email || "",
        });
      } else if (!isReviewer && reviewerMembership) {
        await setReviewerMembership(eventId, {
          enable: false,
          membership_id: reviewerMembership.id,
          person_id: pessoa.person_id,
        });
      }

      queryClient.invalidateQueries({ queryKey: ["event-reviewers", eventId] });
      onSuccess();
      onClose();
      toast.success(t("events.saveSuccess"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle className="font-display">Papéis — {pessoa.full_name}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          {isPartnerRep ? (
            <div className="text-sm text-muted-foreground bg-sky-50 rounded-lg px-3 py-2">
              Esta pessoa é Representante de Parceiro. O papel é gerenciado na aba <strong>Parceiros</strong>.
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Participante é implícito. Selecione papéis adicionais:</p>
              <div className="grid grid-cols-2 gap-2">
                {ROLE_OPTIONS.map(({ value, label }) => {
                  const active = value === "reviewer" ? isReviewer : roles.includes(value);
                  const disabled = value === "reviewer" ? false : disabledRoles.has(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => toggleRole(value)}
                      disabled={disabled}
                      className={`rounded-xl border p-3 text-sm font-medium transition-colors text-center
                        ${active ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground"}
                        ${disabled ? "opacity-35 cursor-not-allowed" : "hover:bg-muted/40"}`}
                    >
                      {label}{active && " ✓"}
                    </button>
                  );
                })}
              </div>
              {checkingReviewer && <p className="text-xs text-muted-foreground">Verificando status de avaliador…</p>}
              {isReviewer && !reviewerUserId && !checkingReviewer && (
                <p className="text-xs text-warning bg-warning/10 rounded-lg px-3 py-2">
                  Esta pessoa não tem conta de acesso (User) com este e-mail. Convide-a para que consiga acessar o painel de avaliação.
                </p>
              )}
            </>
          )}
          {conflict && <p className="text-sm text-destructive bg-red-50 rounded-lg px-3 py-2">{conflict}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          {!isPartnerRep && (
            <Button onClick={handleSave} disabled={saving}>{saving ? t("common.loading") : t("common.save")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { useNavigate } from "react-router-dom";
import { t } from "@/lib/i18n";
import { logAudit } from "@/lib/audit";
import EventForm from "@/components/admin/EventForm";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export default function EventCreate() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const createMut = useMutation({
    mutationFn: async (data) => {
      // O e-mail do gerente não é campo do Event: ele vira vínculo/convite.
      const { manager_email, ...eventData } = data;
      const event = await base44.entities.Event.create({ ...eventData, is_deleted: false });
      // Create default track and room
      await Promise.all([
        base44.entities.Track.create({ event_id: event.id, name: "Principal", color: "#4F46E5", is_deleted: false }),
        base44.entities.Room.create({ event_id: event.id, name: "Plenária", is_deleted: false }),
      ]);

      let manager = null;
      if (manager_email) {
        try {
          const res = await base44.functions.invoke("manageEventInvite", {
            action: "invite",
            eventId: event.id,
            email: manager_email,
            name: eventData.manager_name,
            role: "manager",
          });
          manager = res.data;
        } catch (err) {
          manager = { error: err?.response?.data?.error || err.message };
        }
      }
      return { event, manager };
    },
    onSuccess: ({ event, manager }) => {
      logAudit({ event_id: event.id, action: "create", entity_type: "Event", entity_id: event.id, user });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      toast.success(t("events.saveSuccess"));

      if (manager?.status === "linked") {
        toast.success("Acesso de gerente concedido.");
      } else if (manager?.status === "invited") {
        if (manager.invited) {
          toast.success("Convite enviado ao gerente. O evento já aparece para ele ao concluir o cadastro.");
        } else {
          toast.warning(manager.invite_error || "Não foi possível enviar o convite ao gerente. Reenvie em breve.");
        }
      } else if (manager?.error) {
        toast.error(manager.error);
      }

      navigate(`/events/${event.id}`);
    },
  });

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/events")}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-display font-bold">{t("events.create")}</h1>
      </div>
      <div className="bg-card rounded-2xl border border-border p-5">
        <EventForm
          onSubmit={(data) => createMut.mutate(data)}
          isSubmitting={createMut.isPending}
          allowManagerInvite
        />
      </div>
    </div>
  );
}
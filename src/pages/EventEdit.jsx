import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { useNavigate, useParams } from "react-router-dom";
import { t } from "@/lib/i18n";
import { logAudit } from "@/lib/audit";
import EventForm from "@/components/admin/EventForm";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";

export default function EventEdit() {
  const { user } = useAuth();
  const { eventId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: event, isLoading } = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => {
      const list = await base44.entities.Event.filter({ id: eventId });
      return list[0];
    },
  });

  const updateMut = useMutation({
    mutationFn: (data) => base44.entities.Event.update(eventId, data),
    onSuccess: () => {
      const oldStatus = event?.status;
      const changes = {};
      if (oldStatus && oldStatus !== updateMut.variables?.status) {
        logAudit({ event_id: eventId, action: "status_change", entity_type: "Event", entity_id: eventId, details: { from: oldStatus, to: updateMut.variables.status }, user });
      }
      logAudit({ event_id: eventId, action: "update", entity_type: "Event", entity_id: eventId, user });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      queryClient.invalidateQueries({ queryKey: ["event", eventId] });
      toast.success(t("events.saveSuccess"));
      navigate(`/events/${eventId}`);
    },
  });

  if (isLoading) return <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-display font-bold">{t("events.edit")}</h1>
      </div>
      {event && <EventForm event={event} onSubmit={(data) => updateMut.mutate(data)} isSubmitting={updateMut.isPending} />}
    </div>
  );
}
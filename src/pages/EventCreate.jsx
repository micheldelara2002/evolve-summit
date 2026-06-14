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
      const event = await base44.entities.Event.create({ ...data, is_deleted: false });
      // Create default track and room
      await Promise.all([
        base44.entities.Track.create({ event_id: event.id, name: "Principal", color: "#4F46E5", is_deleted: false }),
        base44.entities.Room.create({ event_id: event.id, name: "Plenária", is_deleted: false }),
      ]);
      return event;
    },
    onSuccess: (event) => {
      logAudit({ event_id: event.id, action: "create", entity_type: "Event", entity_id: event.id, user });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      toast.success(t("events.saveSuccess"));
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
        <EventForm onSubmit={(data) => createMut.mutate(data)} isSubmitting={createMut.isPending} />
      </div>
    </div>
  );
}
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
    mutationFn: (data) => base44.entities.Event.create({ ...data, is_deleted: false }),
    onSuccess: (created) => {
      logAudit({ event_id: created.id, action: "create", entity_type: "Event", entity_id: created.id, user });
      queryClient.invalidateQueries({ queryKey: ["events"] });
      toast.success(t("events.saveSuccess"));
      navigate(`/events/${created.id}`);
    },
  });

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-display font-bold">{t("events.create")}</h1>
      </div>
      <EventForm onSubmit={(data) => createMut.mutate(data)} isSubmitting={createMut.isPending} />
    </div>
  );
}
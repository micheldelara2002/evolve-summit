import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { useParams, useNavigate, Link, Outlet } from "react-router-dom";
import { t } from "@/lib/i18n";
import { canManageEvent } from "@/lib/access";
import StatusBadge from "@/components/admin/StatusBadge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Pencil } from "lucide-react";

export default function EventDetail() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();

  const { data: event, isLoading } = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => { const l = await base44.entities.Event.filter({ id: eventId }); return l[0]; },
  });

  const hasAccess = canManageEvent(user, eventId);

  if (isLoading) return <div className="flex justify-center py-12"><div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  if (!event) return <p className="text-center py-12 text-muted-foreground">{t("events.noEvents")}</p>;
  if (!hasAccess) return (
    <div className="text-center py-24 space-y-3">
      <p className="text-muted-foreground">Você não tem permissão para gerenciar este evento.</p>
      <Button variant="outline" onClick={() => navigate("/events")}>Voltar</Button>
    </div>
  );

  const formatDate = (d) => d ? new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) : "";
  const dateRange = event.start_date ? `${formatDate(event.start_date)}${event.end_date ? " a " + formatDate(event.end_date) : ""}` : "";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/events")} className="mt-1 shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            {event.logo_url ? (
              <img src={event.logo_url} alt="" className="w-12 h-12 rounded-xl object-cover" />
            ) : (
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg" style={{ backgroundColor: event.color_primary || "#4F46E5" }}>
                {event.name?.[0]?.toUpperCase()}
              </div>
            )}
            <div>
              <h1 className="text-xl font-display font-bold">{event.name}</h1>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <StatusBadge status={event.status} />
                {dateRange && <span className="text-xs text-muted-foreground">· {dateRange}</span>}
                {event.manager_name && <span className="text-xs text-muted-foreground">· {event.manager_name}</span>}
              </div>
            </div>
          </div>
          <div className="flex gap-1 mt-3">
            <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: event.color_primary }} />
            <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: event.color_secondary }} />
            <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: event.color_accent }} />
          </div>
        </div>
        {hasAccess && (
          <Link to={`/events/${eventId}/edit`}>
            <Button variant="outline" size="sm" className="gap-1 shrink-0">
              <Pencil className="w-4 h-4" />
              <span className="hidden sm:inline">{t("common.edit")}</span>
            </Button>
          </Link>
        )}
      </div>

      <Outlet context={{ event, eventId, hasAccess, user }} />
    </div>
  );
}
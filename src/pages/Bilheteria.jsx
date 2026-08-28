import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Ticket, Calendar, MapPin, ArrowLeft } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import PullToRefresh from "@/components/ui/PullToRefresh";
import StatusBadge from "@/components/admin/StatusBadge";

// Bilheteria — marketplace de ingressos.
// Lista eventos com venda de ingressos ativa (requires_payment true, status ativo,
// não draft/finished/cancelled). Qualquer usuário autenticado pode navegar e comprar.
export default function Bilheteria() {
  const queryClient = useQueryClient();

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["bilheteria", "events"],
    queryFn: () =>
      base44.entities.Event.filter({
        requires_payment: true,
        status: "active",
        is_deleted: false,
      }),
  });

  const handleRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["bilheteria"] });
  };

  const formatDate = (d) =>
    d
      ? new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" })
      : "";

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <div className="space-y-5">
        <div className="flex items-center gap-2">
          <Link to="/">
            <Button variant="ghost" size="icon" className="shrink-0">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-display font-bold flex items-center gap-2">
              <Ticket className="w-6 h-6 text-primary" /> Bilheteria
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Eventos com ingressos à venda.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-20">
            <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : events.length === 0 ? (
          <div className="text-center py-20 space-y-3">
            <Ticket className="w-12 h-12 text-muted-foreground mx-auto" />
            <p className="text-muted-foreground">
              Nenhum evento com ingressos à venda no momento.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {events.map((event) => (
              <div
                key={event.id}
                className="rounded-2xl bg-card border border-border overflow-hidden"
              >
                <div className="flex items-start gap-3 p-4">
                  {event.logo_url ? (
                    <img
                      src={event.logo_url}
                      alt=""
                      className="w-14 h-14 rounded-xl object-cover shrink-0"
                    />
                  ) : (
                    <div
                      className="w-14 h-14 rounded-xl flex items-center justify-center text-white font-bold text-xl shrink-0"
                      style={{ backgroundColor: event.color_primary || "#4F46E5" }}
                    >
                      {event.name?.[0]?.toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <h2 className="font-display font-bold text-base leading-tight">
                      {event.name}
                    </h2>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <StatusBadge status={event.status} />
                      {event.start_date && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Calendar className="w-3 h-3" /> {formatDate(event.start_date)}
                        </span>
                      )}
                    </div>
                    {event.location && (
                      <p className="inline-flex items-center gap-1 text-xs text-muted-foreground mt-1">
                        <MapPin className="w-3 h-3" /> {event.location}
                      </p>
                    )}
                    {event.description && (
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
                        {event.description}
                      </p>
                    )}
                  </div>
                </div>
                <div className="px-4 pb-4">
                  <Link to={`/event/${event.id}/tickets`}>
                    <Button className="w-full touch-manipulation select-none">
                      <Ticket className="w-4 h-4" /> Comprar ingressos
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </PullToRefresh>
  );
}
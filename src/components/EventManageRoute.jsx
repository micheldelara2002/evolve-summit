/**
 * Protege as rotas de gestão de eventos (/events e módulos do evento):
 * admin global OU gerente/equipe com EventMembership ativa (manager/team).
 * Sem eventId na rota (ex.: lista /events), autoriza quem tem membership
 * de gestão em qualquer evento. Não-admin sem membership → volta para a home.
 */
import { Navigate, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { isAdmin } from "@/lib/access";

export default function EventManageRoute() {
  const { user } = useAuth();
  const { eventId } = useParams();

  const { data: memberships = [], isLoading } = useQuery({
    queryKey: ["manage-route-memberships", user?.id],
    queryFn: () =>
      base44.entities.EventMembership.filter({
        user_id: user.id,
        is_active: true,
        is_deleted: false,
        role: { $in: ["manager", "team"] },
      }),
    enabled: !!user?.id && !isAdmin(user),
  });

  if (isAdmin(user)) return <Outlet />;

  if (isLoading) {
    return (
      <div className="flex justify-center py-24">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const authorized = eventId
    ? memberships.some((m) => m.event_id === eventId)
    : memberships.length > 0;

  if (!authorized) return <Navigate to="/" replace />;
  return <Outlet />;
}
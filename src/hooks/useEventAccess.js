import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { isAdmin } from "@/lib/access";

/**
 * useEventAccess — validação de contexto de evento.
 *
 * Camada de defesa que garante que o usuário logado tem relação legítima
 * com o evento antes de qualquer renderização. Retorna:
 *   - event: o registro do evento (ou null)
 *   - memberships: EventMemberships ativas do usuário neste evento
 *   - hasAccess: true se admin OU se possui papel de gestão (manager/team)
 *   - loading: true enquanto busca evento + memberships
 *
 * Usado por rotas administrativas de evento como gatekeeper central.
 */
const MANAGEMENT_ROLES = ["manager", "team"];

export function useEventAccess(eventId) {
  const { user } = useAuth();

  const { data: event, isLoading: eventLoading } = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => {
      const list = await base44.entities.Event.filter({ id: eventId });
      return list[0] || null;
    },
    enabled: !!eventId,
  });

  const { data: memberships = [], isLoading: membershipsLoading } = useQuery({
    queryKey: ["event-access-memberships", eventId, user?.id],
    queryFn: () =>
      base44.entities.EventMembership.filter({
        user_id: user.id,
        event_id: eventId,
        is_active: true,
        is_deleted: false,
      }),
    enabled: !!user?.id && !!eventId,
  });

  const hasManagementRole = memberships.some(
    (m) => MANAGEMENT_ROLES.includes(m.role)
  );
  const hasAccess = isAdmin(user) || hasManagementRole;

  return {
    event,
    memberships,
    hasAccess,
    loading: eventLoading || membershipsLoading,
  };
}
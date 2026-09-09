/**
 * Módulo "Pessoas" aberto a gestores do evento (EventMembership manager/team).
 * Rota FORA do AdminRoute: guard por useEventAccess (admin OU membership de gestão).
 * Leituras sensíveis (Session — RLS admin-only) e todas as escritas passam pela
 * função manageParticipant, que valida a membership no servidor. Os demais
 * módulos admin seguem inalterados e exclusivos do admin global.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { useEventAccess } from "@/hooks/useEventAccess";
import { getEventSessions } from "@/lib/participantApi";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import ListSkeleton from "@/components/ui/ListSkeleton";
import EmptyState from "@/components/ui/EmptyState";
import PessoasTab from "@/components/admin/PessoasTab";
import { ArrowLeft, Lock, Users } from "lucide-react";

export default function EventPeopleManage() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const { hasAccess, loading } = useEventAccess(eventId);
  const [showImport, setShowImport] = useState(false);

  const { data: participants = [] } = useQuery({
    queryKey: ["participants", eventId],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
    enabled: !!eventId && hasAccess,
  });

  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", eventId],
    queryFn: () => getEventSessions(eventId),
    enabled: !!eventId && hasAccess,
  });

  if (loading) return <ListSkeleton count={4} />;

  if (!hasAccess) {
    return (
      <div className="max-w-2xl mx-auto">
        <EmptyState
          icon={Lock}
          title="Acesso restrito"
          description="Você não tem permissão de gestão neste evento."
        />
        <div className="flex justify-center mt-4">
          <Button variant="outline" onClick={() => navigate("/my-events")} className="gap-2">
            <ArrowLeft className="w-4 h-4" /> Voltar para Meus Eventos
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate("/my-events")} className="shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-lg font-display font-bold flex items-center gap-2">
          <Users className="w-5 h-5 text-primary" />
          {t("adminSections.people")}
        </h2>
      </div>
      <PessoasTab
        eventId={eventId}
        participants={participants}
        sessions={sessions}
        hasAccess={hasAccess}
        showImport={showImport}
        onShowImport={() => setShowImport(true)}
        onHideImport={() => setShowImport(false)}
      />
    </div>
  );
}
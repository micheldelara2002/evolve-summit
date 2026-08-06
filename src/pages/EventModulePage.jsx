import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOutletContext, useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import PessoasTab from "@/components/admin/PessoasTab";
import PartnersTab from "@/components/admin/PartnersTab";
import LojaTab from "@/components/admin/LojaTab";
import PontuacaoTab from "@/components/admin/PontuacaoTab";
import ConquistasTab from "@/components/admin/ConquistasTab";
import FeedbacksTab from "@/components/admin/FeedbacksTab";
import SorteioTab from "@/components/admin/SorteioTab";
import CertificadosTab from "@/components/admin/CertificadosTab";
import SessionRankingSection from "@/components/admin/SessionRankingSection";
import NotificationsCenter from "@/components/notifications/NotificationsCenter";
import EventStructureManager from "@/components/admin/EventStructureManager";
import CallForPapersTab from "@/components/admin/cfp/CallForPapersTab";
import PremiacaoTab from "@/components/admin/PremiacaoTab";

const MODULE_TITLES = {
  people: t("adminSections.people"),
  tracks: t("adminSections.tracks"),
  rooms: t("adminSections.rooms"),
  sessions: t("adminSections.sessions"),
  ranking: t("adminSections.ranking"),
  partners: t("adminSections.partners"),
  store: t("adminSections.store"),
  score: t("adminSections.score"),
  badges: t("adminSections.badges"),
  notifications: t("adminSections.notifications"),
  feedback: t("adminSections.feedback"),
  raffle: t("adminSections.raffle"),
  certificates: t("adminSections.certificates"),
  cfp: t("adminSections.cfp"),
  premiacao: t("adminSections.premiacao"),
  };

function PeopleContent({ eventId, hasAccess }) {
  const [showImport, setShowImport] = useState(false);
  const { data: participants = [] } = useQuery({
    queryKey: ["participants", eventId],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
  });
  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", eventId],
    queryFn: () => base44.entities.Session.filter({ event_id: eventId, is_deleted: false }),
  });
  return (
    <PessoasTab
      eventId={eventId}
      participants={participants}
      sessions={sessions}
      hasAccess={hasAccess}
      showImport={showImport}
      onShowImport={() => setShowImport(true)}
      onHideImport={() => setShowImport(false)}
    />
  );
}

function RankingContent({ eventId }) {
  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions", eventId],
    queryFn: () => base44.entities.Session.filter({ event_id: eventId, is_deleted: false }),
  });
  return <SessionRankingSection eventId={eventId} sessions={sessions} />;
}

export default function EventModulePage({ module }) {
  const { eventId, hasAccess, user } = useOutletContext();
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/events/${eventId}`)} className="shrink-0">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h2 className="text-lg font-display font-bold">{MODULE_TITLES[module]}</h2>
      </div>

      {module === "people" && <PeopleContent eventId={eventId} hasAccess={hasAccess} />}
      {module === "tracks" && <EventStructureManager eventId={eventId} hasAccess={hasAccess} user={user} module="tracks" />}
      {module === "rooms" && <EventStructureManager eventId={eventId} hasAccess={hasAccess} user={user} module="rooms" />}
      {module === "sessions" && <EventStructureManager eventId={eventId} hasAccess={hasAccess} user={user} module="sessions" />}
      {module === "ranking" && <RankingContent eventId={eventId} />}
      {module === "partners" && <PartnersTab eventId={eventId} hasAccess={hasAccess} />}
      {module === "store" && <LojaTab eventId={eventId} hasAccess={hasAccess} user={user} />}
      {module === "score" && <PontuacaoTab eventId={eventId} hasAccess={hasAccess} user={user} />}
      {module === "badges" && <ConquistasTab eventId={eventId} hasAccess={hasAccess} user={user} />}
      {module === "notifications" && (
        <NotificationsCenter
          scopeType="event"
          scopeEventId={eventId}
          metricsPath={`/events/${eventId}/notifications/metrics`}
        />
      )}
      {module === "feedback" && <FeedbacksTab eventId={eventId} />}
      {module === "raffle" && <SorteioTab eventId={eventId} user={user} />}
      {module === "certificates" && <CertificadosTab eventId={eventId} user={user} />}
      {module === "cfp" && <CallForPapersTab eventId={eventId} hasAccess={hasAccess} user={user} />}
      {module === "premiacao" && <PremiacaoTab eventId={eventId} hasAccess={hasAccess} user={user} />}
    </div>
  );
}
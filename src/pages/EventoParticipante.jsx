/**
 * Experiência principal do participante dentro de um evento.
 * Abas: Programação | Loja | Conquistas | Feedback
 * Branding dinâmico por evento.
 * Modo leitura para eventos "finished".
 */
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import { motion } from "framer-motion";
import {
  Calendar, ShoppingBag, Trophy, Briefcase,
  ArrowLeft, Lock, Star, SmilePlus, UserCheck, AlertCircle, Ticket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import ProgramacaoView from "@/components/participante/ProgramacaoView";
import LojaView from "@/components/participante/LojaView";
import ConquistasView from "@/components/participante/ConquistasView";
import MuralFeedback from "@/components/participante/MuralFeedback";
import JobBoardView from "@/components/participante/JobBoardView";
import SponsorsStrip from "@/components/participante/SponsorsStrip";
import PartnerVisitModal from "@/components/participante/PartnerVisitModal";
import SectionIconGrid from "@/components/ui/SectionIconGrid";
import { useSectionParam } from "@/lib/useSectionParam";
import { t } from "@/lib/i18n";

function isValidHex(color) {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

const SECTIONS = [
  { id: "schedule", labelKey: "eventSections.schedule", icon: Calendar },
  { id: "store",    labelKey: "eventSections.store",    icon: ShoppingBag },
  { id: "badges",   labelKey: "eventSections.badges",    icon: Trophy },
  { id: "jobs",     labelKey: "eventSections.jobs",      icon: Briefcase },
  { id: "feedback", labelKey: "eventSections.feedback", icon: SmilePlus },
];

const LEGACY_TAB_MAP = {
  programacao: "schedule",
  loja: "store",
  rede: "schedule",
  conquistas: "badges",
  mural: "feedback",
  vagas: "jobs",
  ferramentas: "feedback",
};

export default function EventoParticipante() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useSectionParam({ defaultSection: "schedule", legacyTabMap: LEGACY_TAB_MAP });
  const [scanPartnerId, setScanPartnerId] = useState(null);

  // Fetch event
  const { data: event, isLoading: loadingEvent, error: eventError } = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => {
      const evs = await base44.entities.Event.filter({ id: eventId, is_deleted: false });
      return evs[0] || null;
    },
  });

  // Check participant association
  const { data: myParticipant, isLoading: loadingParticipant } = useQuery({
    queryKey: ["my_participant_check", eventId, user?.email],
    queryFn: () =>
      base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
    enabled: !!user && !!eventId,
  });

  // User's person_id lookup
  const { data: myPerson } = useQuery({
    queryKey: ["my_person_for_event", user?.email],
    queryFn: async () => {
      const list = await base44.entities.Person.filter({ contact_email: user?.email, is_active: true });
      return list[0] || null;
    },
    enabled: !!user,
  });

  const isLoading = loadingEvent || loadingParticipant;

  // Determine if user is associated
  const myParticipantRecord = myParticipant?.find(
    (p) =>
      p.email === user?.email ||
      (myPerson && p.person_id === myPerson?.id)
  );
  const isAssociated = !!myParticipantRecord;

  const isFinished = event?.status === "finished";
  const isCheckedIn = myParticipantRecord?.checkin_status === "confirmed";
  // Bloqueia interações se evento encerrado OU participante sem check-in
  const isReadOnly = isFinished || !isCheckedIn;
  const isCheckinPending = !isFinished && !isCheckedIn;

  // Dynamic branding
  useEffect(() => {
    if (!event) return;
    const root = document.documentElement;
    if (isValidHex(event.color_primary)) {
      root.style.setProperty("--event-primary", event.color_primary);
    }
    return () => {
      root.style.removeProperty("--event-primary");
    };
  }, [event]);

  // Detect partner_scan URL param (from external QR scan via phone camera)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const partnerScan = urlParams.get("partner_scan");
    if (partnerScan) {
      setScanPartnerId(partnerScan);
      urlParams.delete("partner_scan");
      const newSearch = urlParams.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${newSearch ? "?" + newSearch : ""}`);
    }
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!event) {
    return (
      <div className="text-center py-24 space-y-3">
        <p className="text-muted-foreground">Evento não encontrado.</p>
        <Button variant="outline" onClick={() => navigate("/meus-eventos")}>
          Voltar
        </Button>
      </div>
    );
  }

  if (!isAssociated) {
    const needsTicket = !!event?.requires_payment;
    return (
      <div className="text-center py-24 space-y-4 max-w-sm mx-auto">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
          {needsTicket ? <Ticket className="w-8 h-8 text-primary" /> : <Lock className="w-8 h-8 text-muted-foreground" />}
        </div>
        <h2 className="text-xl font-display font-bold">{needsTicket ? "Ingressos disponíveis" : "Acesso Restrito"}</h2>
        <p className="text-muted-foreground text-sm">
          {needsTicket
            ? "Você não está inscrito neste evento. Compre seu ingresso para garantir sua participação."
            : "Você não está inscrito neste evento. Solicite acesso ao organizador."}
        </p>
        {needsTicket ? (
          <Button onClick={() => navigate(`/event/${eventId}/tickets`)}>
            <Ticket className="w-4 h-4 mr-2" /> Comprar ingressos
          </Button>
        ) : null}
        <div>
          <Button variant="outline" onClick={() => navigate("/meus-eventos")}>
            <ArrowLeft className="w-4 h-4 mr-2" /> Voltar
          </Button>
        </div>
      </div>
    );
  }

  const primaryColor = isValidHex(event.color_primary) ? event.color_primary : "#4F46E5";
  const secondaryColor = isValidHex(event.color_secondary) ? event.color_secondary : "#0D9488";

  return (
    <div className="min-h-screen bg-background">
      {/* Event header / branding */}
      <div
        className="relative px-4 pt-4 pb-0"
        style={{ background: `linear-gradient(135deg, ${primaryColor}18 0%, ${secondaryColor}10 100%)` }}
      >
        {/* Back + read-only badge */}
        <div className="flex items-center justify-between mb-3 max-w-4xl mx-auto">
          <Button variant="ghost" size="sm" onClick={() => navigate("/meus-eventos")} className="gap-1.5 -ml-2 h-11 sm:h-8">
            <ArrowLeft className="w-4 h-4" /> Meus Eventos
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(`/event/${eventId}/tickets`)}
              className="h-8 gap-1.5 touch-manipulation select-none"
            >
              <Ticket className="w-4 h-4" /> Ingressos
            </Button>
            {isFinished ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-warning/10 text-warning border border-warning/20">
                <Lock className="w-3 h-3" /> Modo consulta
              </span>
            ) : isCheckinPending ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                <UserCheck className="w-3 h-3" /> Check-in pendente
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                <UserCheck className="w-3 h-3" /> Presente
              </span>
            )}
          </div>
        </div>

        {/* Event identity */}
        <div className="flex items-center gap-4 max-w-4xl mx-auto pb-4">
          {event.logo_url ? (
            <img src={event.logo_url} alt={event.name} className="w-14 h-14 rounded-xl object-cover shadow-md shrink-0" />
          ) : (
            <div
              className="w-14 h-14 rounded-xl flex items-center justify-center text-white font-display font-bold text-xl shadow-md shrink-0"
              style={{ backgroundColor: primaryColor }}
            >
              {event.name?.[0]?.toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl font-display font-bold truncate">{event.name}</h1>
            {event.location && (
              <p className="text-xs text-muted-foreground mt-0.5">{event.location}</p>
            )}
          </div>
          <PointsChip eventId={eventId} userEmail={user?.email} myPerson={myPerson} primaryColor={primaryColor} />
        </div>

        {/* Sponsors strip */}
        <div className="max-w-4xl mx-auto pb-3 px-0">
          <SponsorsStrip eventId={eventId} />
        </div>

        {/* Section grid */}
        <div className="max-w-4xl mx-auto pb-0">
          <SectionIconGrid
            sections={SECTIONS.map((s) => ({ ...s, label: t(s.labelKey) }))}
            activeSection={activeTab}
            onSectionChange={setActiveTab}
          />
        </div>
      </div>

      {/* Tab content */}
      <div className="max-w-4xl mx-auto px-4 py-6">
        {isCheckinPending && (
          <div className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span><strong>Check-in pendente.</strong> Dirija-se ao balcão de credenciamento para liberar suas interações no evento.</span>
          </div>
        )}
        {isFinished && (
          <div className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-warning/10 border border-warning/20 text-warning text-sm">
            <Lock className="w-4 h-4 shrink-0" />
            Este evento está encerrado. Visualização somente leitura.
          </div>
        )}

        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15 }}
        >
          {activeTab === "schedule" && (
            <ProgramacaoView
              eventId={eventId}
              participant={myParticipantRecord}
              isReadOnly={isReadOnly}
              event={event}
            />
          )}
          {activeTab === "store" && (
            <LojaView
              eventId={eventId}
              participantId={myParticipantRecord?.id}
              personId={myPerson?.id}
              isReadOnly={isReadOnly}
            />
          )}
          {activeTab === "feedback" && (
            <MuralFeedback
              eventId={eventId}
              participantId={myParticipantRecord?.id}
              personId={myPerson?.id}
              userId={user?.id}
              isReadOnly={isReadOnly}
            />
          )}
          {activeTab === "badges" && (
            <ConquistasView eventId={eventId} userEmail={user?.email} myPerson={myPerson} participantId={myParticipantRecord?.id} />
          )}
          {activeTab === "jobs" && (
            <JobBoardView
              eventId={eventId}
              myPerson={myPerson}
              myParticipant={myParticipantRecord}
              user={user}
              isReadOnly={isReadOnly}
            />
          )}
        </motion.div>
      </div>

      <PartnerVisitModal
        partnerId={scanPartnerId}
        eventId={eventId}
        personId={myPerson?.id}
        participantId={myParticipantRecord?.id}
        person={myPerson}
        isReadOnly={isReadOnly}
        onClose={() => setScanPartnerId(null)}
      />
    </div>
  );
}

// ── Points chip near header ──────────────────────────────────────────────────
function PointsChip({ eventId, userEmail, myPerson, primaryColor }) {
  // For now, show placeholder — real scoring engine to be connected later
  const { data: participants = [] } = useQuery({
    queryKey: ["my_participant_points", eventId, userEmail],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
  });

  const myParticipant = participants.find(
    (p) => p.email === userEmail || (myPerson && p.person_id === myPerson?.id)
  );

  const points = myParticipant?.points_total ?? 0;

  return (
    <div
      className="ml-auto shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-white text-sm font-medium shadow"
      style={{ backgroundColor: primaryColor }}
    >
      <Star className="w-3.5 h-3.5" />
      <span>{points} pts</span>
    </div>
  );
}
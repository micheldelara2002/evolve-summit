/**
 * Painel do Parceiro — escopo por evento, com separação de permissões:
 *  - partner_manager: vê dashboard + todos os eventos do seu partner
 *  - representative (member): vê apenas eventos onde tem vínculo (Participant partner_rep)
 *  - admin: acesso total
 */
import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useAuth } from "@/lib/AuthContext";
import { Handshake, Lock, Calendar, Users, Trophy, QrCode, Award, Bell } from "lucide-react";
import { isAdmin, isPartnerManager } from "@/lib/access";
import PartnerDashboard from "@/components/parceiro/PartnerDashboard";
import PartnerLeadsTab from "@/components/parceiro/PartnerLeadsTab";
import PartnerQRTab from "@/components/parceiro/PartnerQRTab";
import PartnerSponsorshipTab from "@/components/parceiro/PartnerSponsorshipTab";
import PartnerNotificationsTab from "@/components/parceiro/PartnerNotificationsTab";
import PartnerRaffleSection from "@/components/parceiro/PartnerRaffleSection";
import SectionIconGrid from "@/components/ui/SectionIconGrid";
import PageHeader from "@/components/layout/PageHeader";
import { useSectionParam } from "@/lib/useSectionParam";
import { t } from "@/lib/i18n";

const SECTIONS = [
  { id: "leads", labelKey: "partnerSections.leads", icon: Users },
  { id: "raffle", labelKey: "partnerSections.raffle", icon: Trophy },
  { id: "qr", labelKey: "partnerSections.qr", icon: QrCode },
  { id: "sponsorship", labelKey: "partnerSections.sponsorship", icon: Award },
  { id: "notifications", labelKey: "partnerSections.notifications", icon: Bell },
];

const LEGACY_TAB_MAP = {
  sorteio: "raffle",
  patrocinio: "sponsorship",
  notificacoes: "notifications",
};

export default function PainelParceiro() {
  const { user } = useAuth();
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [activeTab, setActiveTab] = useSectionParam({ defaultSection: "leads", legacyTabMap: LEGACY_TAB_MAP });

  // Resolve person do usuário
  const { data: myPerson } = useQuery({
    queryKey: ["my_person_partner", user?.person_id, user?.email],
    queryFn: async () => {
      if (user?.person_id) {
        const list = await base44.entities.Person.filter({ id: user.person_id });
        if (list[0]) return list[0];
      }
      const list = await base44.entities.Person.filter({ contact_email: user?.email, is_active: true });
      return list[0] || null;
    },
    enabled: !!user,
  });

  // PartnerRepresentative do usuário (carregados no login via AuthContext)
  const myReps = user?.partner_reps || [];

  // Determinar partner_id
  const partnerId = useMemo(() => {
    if (!myReps.length) return null;
    if (isPartnerManager(user)) {
      const mgr = myReps.find((r) => r.role_in_partner === "partner_manager");
      return (mgr || myReps[0]).partner_id;
    }
    return myReps[0].partner_id;
  }, [myReps, user]);

  // Registro do partner
  const { data: partner } = useQuery({
    queryKey: ["partner_record", partnerId],
    queryFn: async () => {
      const list = await base44.entities.Partner.filter({ id: partnerId });
      return list[0] || null;
    },
    enabled: !!partnerId,
  });

  // EventPartner do partner
  const { data: eventPartners = [], isLoading: loadingEventPartners } = useQuery({
    queryKey: ["event_partners_for_partner", partnerId],
    queryFn: async () => {
      const res = await base44.functions.invoke('getEventPartners', { partnerId });
      return res.data?.eventPartners || [];
    },
    enabled: !!partnerId,
  });

  const eventIdsFromPartner = eventPartners.map((ep) => ep.event_id);

  // Eventos do partner — query direcionada por id ($in)
  const { data: events = [], isLoading: loadingEvents } = useQuery({
    queryKey: ["partner_events", eventIdsFromPartner.join(",")],
    queryFn: async () => {
      if (!eventIdsFromPartner.length) return [];
      return base44.entities.Event.filter({
        id: { $in: eventIdsFromPartner },
        is_deleted: false,
      });
    },
    enabled: eventIdsFromPartner.length > 0,
  });

  // Para representante: participações como partner_rep — queries direcionadas por person_id e email
  const { data: myPartnerships = [], isLoading: loadingPartnerships } = useQuery({
    queryKey: ["my_partner_participations", user?.person_id, user?.email],
    queryFn: async () => {
      const queries = [];
      if (user?.person_id) {
        queries.push(base44.entities.Participant.filter({ person_id: user.person_id, is_deleted: false }));
      }
      if (user?.email) {
        queries.push(base44.entities.Participant.filter({ email: user.email, is_deleted: false }));
      }
      if (!queries.length) return [];
      const [byPerson, byEmail] = await Promise.all(queries);
      const merged = [...(byPerson ?? []), ...(byEmail ?? [])];
      // Deduplica por Participant.id (mesmo registro pode aparecer nas duas queries)
      const seen = new Map();
      for (const p of merged) {
        if (!seen.has(p.id)) seen.set(p.id, p);
      }
      return Array.from(seen.values()).filter((p) => p.role_in_event === "partner_rep");
    },
    enabled: !!user && !isPartnerManager(user) && !isAdmin(user),
  });

  // Eventos acessíveis
  const accessibleEvents = useMemo(() => {
    if (isAdmin(user) || isPartnerManager(user)) return events;
    const myEventIds = new Set(myPartnerships.map((p) => p.event_id));
    return events.filter((e) => myEventIds.has(e.id));
  }, [events, myPartnerships, user]);

  // Auto-selecionar primeiro evento
  useEffect(() => {
    if (!selectedEventId && accessibleEvents.length > 0) {
      setSelectedEventId(accessibleEvents[0].id);
    }
  }, [accessibleEvents, selectedEventId]);

  const isManager = isAdmin(user) || isPartnerManager(user);
  const selectedEvent = accessibleEvents.find((e) => e.id === selectedEventId);
  const isReadOnly = selectedEvent?.status === "finished";

  // Loading enquanto resolve TODA a cadeia: person → reps → eventPartners → events (+ partnerships p/ representante)
  // myPerson === undefined significa que ainda está carregando (null = carregou e não encontrou)
  const isLoadingPerson = myPerson === undefined;
  const isLoadingAccessibleEvents =
    loadingEventPartners ||
    (eventIdsFromPartner.length > 0 && loadingEvents) ||
    loadingPartnerships;

  if (isLoadingPerson || (partnerId && isLoadingAccessibleEvents)) {
    return (
      <div className="flex justify-center py-24">
        <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!partnerId) {
    return (
      <div className="text-center py-24 space-y-3 max-w-sm mx-auto">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
          <Lock className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-display font-bold">Acesso Restrito</h2>
        <p className="text-sm text-muted-foreground">
          Você não está vinculado a nenhum parceiro. Solicite acesso ao administrador.
        </p>
      </div>
    );
  }

  if (accessibleEvents.length === 0) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <PageHeader icon={Handshake} title="Painel do Parceiro" subtitle={partner?.trade_name || user?.full_name} tone="warning" />
        <div className="text-center py-20 space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
            <Calendar className="w-8 h-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-display font-semibold">Nenhum evento disponível</h2>
          <p className="text-sm text-muted-foreground">
            {isManager
              ? "Seu parceiro ainda não está ativo em nenhum evento."
              : "Você não está associado como representante em nenhum evento deste parceiro."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader icon={Handshake} title="Painel do Parceiro" subtitle={partner?.trade_name || user?.full_name} tone="warning" />

      {/* Event selector */}
      <div className="flex items-center gap-3 flex-wrap">
        <Calendar className="w-4 h-4 text-muted-foreground shrink-0" />
        <select
          className="rounded-lg border border-input bg-transparent px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-w-56 flex-1 sm:flex-none"
          value={selectedEventId || ""}
          onChange={(e) => setSelectedEventId(e.target.value)}
        >
          {accessibleEvents.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        {isReadOnly && (
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-warning/10 text-warning border border-warning/20">
            <Lock className="w-3 h-3" /> Modo consulta
          </span>
        )}
      </div>

      {/* Dashboard — apenas manager */}
      {isManager && <PartnerDashboard partnerId={partnerId} />}

      <SectionIconGrid
        sections={SECTIONS.map((s) => ({ id: s.id, label: t(s.labelKey), icon: s.icon }))}
        activeSection={activeTab}
        onSectionChange={setActiveTab}
      />

      {/* Tab content */}
      <div>
        {activeTab === "leads" && (
          <PartnerLeadsTab eventId={selectedEventId} partnerId={partnerId} isReadOnly={isReadOnly} user={user} myPerson={myPerson} />
        )}
        {activeTab === "raffle" && (
          <PartnerRaffleSection eventId={selectedEventId} partnerId={partnerId} user={user} isReadOnly={isReadOnly} drawnByLabel={partner?.trade_name || user?.full_name} />
        )}
        {activeTab === "qr" && (
          <PartnerQRTab eventId={selectedEventId} partnerId={partnerId} partner={partner} event={selectedEvent} />
        )}
        {activeTab === "sponsorship" && (
          <PartnerSponsorshipTab eventId={selectedEventId} partnerId={partnerId} />
        )}
        {activeTab === "notifications" && (
          <PartnerNotificationsTab eventId={selectedEventId} partnerId={partnerId} user={user} isReadOnly={isReadOnly} />
        )}
      </div>
    </div>
  );
}
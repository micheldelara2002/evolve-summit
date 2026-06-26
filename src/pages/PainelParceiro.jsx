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
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Handshake, Lock, Calendar, Users, Trophy, QrCode, Award, Bell } from "lucide-react";
import { isAdmin, isPartnerManager } from "@/lib/access";
import PartnerDashboard from "@/components/parceiro/PartnerDashboard";
import PartnerLeadsTab from "@/components/parceiro/PartnerLeadsTab";
import PartnerQRTab from "@/components/parceiro/PartnerQRTab";
import PartnerSponsorshipTab from "@/components/parceiro/PartnerSponsorshipTab";
import PartnerNotificationsTab from "@/components/parceiro/PartnerNotificationsTab";
import PartnerRaffleSection from "@/components/parceiro/PartnerRaffleSection";

const TABS = [
  { key: "leads", label: "Leads", icon: Users },
  { key: "sorteio", label: "Sorteio", icon: Trophy },
  { key: "qr", label: "QR Code", icon: QrCode },
  { key: "patrocinio", label: "Patrocínio", icon: Award },
  { key: "notificacoes", label: "Notificações", icon: Bell },
];

export default function PainelParceiro() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [activeTab, setActiveTab] = useState("leads");

  // Resolve person do usuário
  const { data: myPerson } = useQuery({
    queryKey: ["my_person_partner", user?.person_id, user?.email],
    queryFn: async () => {
      if (user?.person_id) {
        const list = await base44.entities.Person.filter({ id: user.person_id });
        if (list[0]) return list[0];
      }
      const all = await base44.entities.Person.filter({ is_active: true });
      return all.find((p) => p.contact_email === user?.email) || null;
    },
    enabled: !!user,
  });

  // Resolve PartnerRepresentative do usuário
  const { data: myReps = [], isLoading: loadingReps } = useQuery({
    queryKey: ["my_partner_reps_panel", user?.id, user?.person_id, myPerson?.id],
    queryFn: async () => {
      const all = await base44.entities.PartnerRepresentative.filter({ is_deleted: false, is_active: true });
      return all.filter(
        (r) => r.user_id === user?.id || r.person_id === myPerson?.id || r.person_id === user?.person_id
      );
    },
    enabled: !!user && !!myPerson,
  });

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
  const { data: eventPartners = [] } = useQuery({
    queryKey: ["event_partners_for_partner", partnerId],
    queryFn: () => base44.entities.EventPartner.filter({ partner_id: partnerId, is_active: true, is_deleted: false }),
    enabled: !!partnerId,
  });

  const eventIdsFromPartner = eventPartners.map((ep) => ep.event_id);

  // Eventos do partner
  const { data: events = [] } = useQuery({
    queryKey: ["partner_events", eventIdsFromPartner.join(",")],
    queryFn: async () => {
      if (!eventIdsFromPartner.length) return [];
      const all = await base44.entities.Event.filter({ is_deleted: false });
      return all.filter((e) => eventIdsFromPartner.includes(e.id));
    },
    enabled: eventIdsFromPartner.length > 0,
  });

  // Para representante: participações como partner_rep
  const { data: myPartnerships = [] } = useQuery({
    queryKey: ["my_partner_participations", user?.person_id, user?.email],
    queryFn: async () => {
      const all = await base44.entities.Participant.filter({ is_deleted: false });
      return all.filter(
        (p) =>
          p.role_in_event === "partner_rep" &&
          (p.person_id === user?.person_id || p.person_id === myPerson?.id || p.email === user?.email)
      );
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

  if (loadingReps) {
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
        <Button variant="outline" onClick={() => navigate("/")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Voltar
        </Button>
      </div>
    );
  }

  if (accessibleEvents.length === 0) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <Header user={user} partner={partner} navigate={navigate} />
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
      <Header user={user} partner={partner} navigate={navigate} />

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

      {/* Tabs */}
      <div className="flex gap-0.5 overflow-x-auto border-b border-border scrollbar-hide">
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = activeTab === key;
          return (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap shrink-0
                ${active
                  ? "bg-background text-foreground shadow-sm border border-b-0 border-border -mb-px"
                  : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div>
        {activeTab === "leads" && (
          <PartnerLeadsTab eventId={selectedEventId} partnerId={partnerId} isReadOnly={isReadOnly} user={user} myPerson={myPerson} />
        )}
        {activeTab === "sorteio" && (
          <PartnerRaffleSection eventId={selectedEventId} partnerId={partnerId} user={user} isReadOnly={isReadOnly} drawnByLabel={partner?.trade_name || user?.full_name} />
        )}
        {activeTab === "qr" && (
          <PartnerQRTab eventId={selectedEventId} partnerId={partnerId} partner={partner} event={selectedEvent} />
        )}
        {activeTab === "patrocinio" && (
          <PartnerSponsorshipTab eventId={selectedEventId} partnerId={partnerId} />
        )}
        {activeTab === "notificacoes" && (
          <PartnerNotificationsTab eventId={selectedEventId} partnerId={partnerId} user={user} isReadOnly={isReadOnly} />
        )}
      </div>
    </div>
  );
}

function Header({ user, partner, navigate }) {
  return (
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="sm" onClick={() => navigate("/")} className="-ml-2">
        <ArrowLeft className="w-4 h-4 mr-1" /> Voltar
      </Button>
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-xl bg-warning/10 border border-warning/20 flex items-center justify-center shrink-0 overflow-hidden">
          {partner?.logo_url ? (
            <img src={partner.logo_url} alt={partner.trade_name} className="w-full h-full object-contain" />
          ) : (
            <Handshake className="w-5 h-5 text-warning" />
          )}
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-display font-bold flex items-center gap-2">
            Painel do Parceiro
          </h1>
          <p className="text-sm text-muted-foreground truncate">{partner?.trade_name || user?.full_name}</p>
        </div>
      </div>
    </div>
  );
}
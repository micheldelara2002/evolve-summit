/**
 * Experiência principal do participante dentro de um evento.
 * Abas: Programação | Loja | Rede | Conquistas | Ferramentas
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
  Calendar, ShoppingBag, Users, Trophy, Wrench,
  ArrowLeft, Lock, Star, QrCode, MessageSquare, SmilePlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import ProgramacaoView from "@/components/participante/ProgramacaoView";
import LojaView from "@/components/participante/LojaView";
import ConquistasView from "@/components/participante/ConquistasView";
import MuralFeedback from "@/components/participante/MuralFeedback";

const TABS = [
  { key: "programacao", label: "Programação", icon: Calendar },
  { key: "loja",        label: "Loja",         icon: ShoppingBag },
  { key: "rede",        label: "Rede",          icon: Users },
  { key: "conquistas",  label: "Conquistas",    icon: Trophy },
  { key: "mural",       label: "Feedback",      icon: SmilePlus },
  { key: "ferramentas", label: "Ferramentas",   icon: Wrench },
];

export default function EventoParticipante() {
  const { eventId } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("programacao");

  // Fetch event
  const { data: event, isLoading: loadingEvent, error: eventError } = useQuery({
    queryKey: ["event", eventId],
    queryFn: async () => {
      const evs = await base44.entities.Event.filter({ is_deleted: false });
      return evs.find((e) => e.id === eventId) || null;
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
      const all = await base44.entities.Person.filter({ is_active: true });
      return all.find((p) => p.contact_email === user?.email) || null;
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
  const isReadOnly = isFinished;

  // Dynamic branding
  useEffect(() => {
    if (!event) return;
    const root = document.documentElement;
    if (event.color_primary) {
      // Convert hex to HSL for CSS variables (simple approximation via inline style on root)
      root.style.setProperty("--event-primary", event.color_primary);
    }
    return () => {
      root.style.removeProperty("--event-primary");
    };
  }, [event]);

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
    return (
      <div className="text-center py-24 space-y-4 max-w-sm mx-auto">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
          <Lock className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-display font-bold">Acesso Restrito</h2>
        <p className="text-muted-foreground text-sm">
          Você não está inscrito neste evento. Solicite acesso ao organizador.
        </p>
        <Button variant="outline" onClick={() => navigate("/meus-eventos")}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Voltar
        </Button>
      </div>
    );
  }

  const primaryColor = event.color_primary || "#4F46E5";
  const secondaryColor = event.color_secondary || "#0D9488";

  return (
    <div className="min-h-screen bg-background">
      {/* Event header / branding */}
      <div
        className="relative px-4 pt-4 pb-0"
        style={{ background: `linear-gradient(135deg, ${primaryColor}18 0%, ${secondaryColor}10 100%)` }}
      >
        {/* Back + read-only badge */}
        <div className="flex items-center justify-between mb-3 max-w-4xl mx-auto">
          <Button variant="ghost" size="sm" onClick={() => navigate("/meus-eventos")} className="gap-1.5 -ml-2">
            <ArrowLeft className="w-4 h-4" /> Meus Eventos
          </Button>
          {isReadOnly && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700 border border-amber-200">
              <Lock className="w-3 h-3" /> Modo consulta
            </span>
          )}
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
          {/* Points chip — placeholder, real data wired below */}
          <PointsChip eventId={eventId} userEmail={user?.email} myPerson={myPerson} primaryColor={primaryColor} />
        </div>

        {/* Tab bar */}
        <div className="flex gap-0.5 overflow-x-auto max-w-4xl mx-auto pb-0 scrollbar-hide">
          {TABS.map(({ key, label, icon: Icon }) => {
            const active = activeTab === key;
            return (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap shrink-0
                  ${active
                    ? "bg-background text-foreground shadow-sm border border-b-0 border-border"
                    : "text-muted-foreground hover:text-foreground hover:bg-background/50"
                  }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      <div className="max-w-4xl mx-auto px-4 py-6">
        {isReadOnly && (
          <div className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm">
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
          {activeTab === "programacao" && (
            <ProgramacaoView
              eventId={eventId}
              participant={myParticipantRecord}
              isReadOnly={isReadOnly}
              event={event}
            />
          )}
          {activeTab === "loja" && (
            <LojaView
              eventId={eventId}
              participantId={myParticipantRecord?.id}
              personId={myPerson?.id}
              isReadOnly={isReadOnly}
            />
          )}
          {activeTab === "mural" && (
            <MuralFeedback
              eventId={eventId}
              participantId={myParticipantRecord?.id}
              personId={myPerson?.id}
              userId={user?.id}
              isReadOnly={isReadOnly}
            />
          )}
          {activeTab === "rede" && <RedeView />}
          {activeTab === "conquistas" && (
            <ConquistasView eventId={eventId} userEmail={user?.email} myPerson={myPerson} />
          )}
          {activeTab === "ferramentas" && <FerramentasView isReadOnly={isReadOnly} />}
        </motion.div>
      </div>
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

  const points = myParticipant?.points_total ?? myParticipant?.points ?? 0;

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

// ── Rede placeholder ──────────────────────────────────────────────────────────
function RedeView() {
  return (
    <div className="text-center py-16 space-y-3">
      <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
        <Users className="w-8 h-8 text-muted-foreground" />
      </div>
      <h3 className="text-lg font-display font-semibold">Rede / Conexões</h3>
      <p className="text-sm text-muted-foreground max-w-xs mx-auto">
        Aqui você poderá ver e conectar-se com outros participantes do evento. Em breve!
      </p>
    </div>
  );
}

// ── Ferramentas ───────────────────────────────────────────────────────────────
function FerramentasView({ isReadOnly }) {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-display font-semibold">Ferramentas</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* QR Code Reader */}
        <div className="rounded-2xl border border-border bg-card p-5 flex flex-col items-center gap-3 text-center">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <QrCode className="w-6 h-6 text-primary" />
          </div>
          <div>
            <p className="font-semibold">Ler QR Code</p>
            <p className="text-xs text-muted-foreground mt-1">
              Escaneie o QR Code de parceiros para registrar visitas ao estande.
            </p>
          </div>
          <Button variant="outline" size="sm" disabled className="w-full">
            Em breve
          </Button>
        </div>

        {/* Mural de Feedback */}
        <div className="rounded-2xl border border-border bg-card p-5 flex flex-col items-center gap-3 text-center">
          <div className="w-12 h-12 rounded-xl bg-secondary/10 flex items-center justify-center">
            <MessageSquare className="w-6 h-6 text-secondary" />
          </div>
          <div>
            <p className="font-semibold">Mural de Feedback</p>
            <p className="text-xs text-muted-foreground mt-1">
              Envie feedback sobre sessões, o evento e sua experiência.
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={isReadOnly} className="w-full">
            {isReadOnly ? "Modo consulta" : "Em breve"}
          </Button>
        </div>
      </div>
    </div>
  );
}
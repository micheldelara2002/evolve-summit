import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useOutletContext, useSearchParams, Navigate } from "react-router-dom";
import EventModuleNav from "@/components/admin/EventModuleNav";
import { getEventSalesSummary } from "@/lib/commerceApi";

const LEGACY_TAB_MAP = {
  pessoas: "people", people: "people",
  tracks: "tracks", trilhas: "tracks",
  rooms: "rooms", salas: "rooms",
  sessions: "sessions", sessoes: "sessions",
  ranking: "ranking",
  partners: "partners", parceiros: "partners",
  store: "store", loja: "store",
  score: "score", pontuacao: "score",
  badges: "badges", conquistas: "badges",
  notifications: "notifications", notificacoes: "notifications",
  feedback: "feedback", feedbacks: "feedback",
  raffle: "raffle", sorteio: "raffle",
  certificates: "certificates", certificados: "certificates",
};

export default function EventModulesHome() {
  const { eventId } = useOutletContext();
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab");

  // Legacy redirect: ?tab=xxx → /events/:eventId/xxx
  if (tab) {
    const mapped = LEGACY_TAB_MAP[tab] || tab;
    return <Navigate to={`/events/${eventId}/${mapped}`} replace />;
  }

  return <EventModulesHomeContent eventId={eventId} />;
}

function EventModulesHomeContent({ eventId }) {
  const { data: participants = [] } = useQuery({
    queryKey: ["participants", eventId],
    queryFn: () => base44.entities.Participant.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: certificates = [] } = useQuery({
    queryKey: ["certificates-count", eventId],
    queryFn: () => base44.entities.Certificate.filter({ event_id: eventId, is_deleted: false }),
  });

  const { data: sales } = useQuery({
    queryKey: ["event-sales-summary", eventId],
    queryFn: () => getEventSalesSummary(eventId),
  });

  const stats = [
    { value: participants.length, label: "Participantes", sub: `${participants.filter((p) => p.registration_status === "confirmed").length} confirmados` },
    { value: participants.filter((p) => p.checkin_status === "confirmed").length, label: "Check-in", sub: "presentes" },
    { value: certificates.length, label: "Certificados", sub: "emitidos" },
  ];

  return (
    <div className="space-y-4">
      {/* Stat header — 3 indicators only */}
      <div className="rounded-2xl bg-primary text-primary-foreground p-5">
        <div className="grid grid-cols-3 gap-2">
          {stats.map((stat, i) => (
            <div key={i} className="bg-card rounded-xl p-3 text-center">
              <p className="text-2xl font-bold text-foreground">{stat.value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{stat.label}</p>
              <p className="text-[10px] text-muted-foreground/70">{stat.sub}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Sales big numbers */}
      {sales && (sales.ticketsSold > 0 || sales.revenue > 0 || sales.ordersPaid > 0) && (
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-card rounded-xl p-3 text-center border border-border">
            <p className="text-2xl font-bold text-primary">{sales.ticketsSold}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Ingressos vendidos</p>
            <p className="text-[10px] text-muted-foreground/70">{sales.ticketsUsed} usados</p>
          </div>
          <div className="bg-card rounded-xl p-3 text-center border border-border">
            <p className="text-2xl font-bold text-primary">R$ {Number(sales.revenue).toFixed(2)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Receita</p>
            <p className="text-[10px] text-muted-foreground/70">{sales.ordersPaid} pedido(s)</p>
          </div>
          <div className="bg-card rounded-xl p-3 text-center border border-border">
            <p className="text-2xl font-bold text-primary">{sales.checkins}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Check-ins</p>
            <p className="text-[10px] text-muted-foreground/70">confirmados</p>
          </div>
        </div>
      )}

      {/* Module navigation cards */}
      <EventModuleNav eventId={eventId} />
    </div>
  );
}
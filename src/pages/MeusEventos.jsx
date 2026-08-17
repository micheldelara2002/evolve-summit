/**
 * Página "Meus Eventos" para usuários não-admin.
 * Mostra apenas eventos active/finished em que o usuário tem Participant vinculado.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/AuthContext";
import { isAdmin } from "@/lib/access";
import { base44 } from "@/api/base44Client";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Calendar, Clock, Lock } from "lucide-react";
import StatusBadge from "@/components/admin/StatusBadge";
import ListSkeleton from "@/components/ui/ListSkeleton";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/layout/PageHeader";
import PullToRefresh from "@/components/ui/PullToRefresh";

function isValidHex(color) {
  return typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color);
}

function EventCard({ event, index, isFinished }) {
  const navigate = useNavigate();
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
      onClick={() => navigate(`/event/${event.id}`)}
      className={`flex items-center gap-4 p-4 rounded-2xl border cursor-pointer hover:shadow-md transition-all group
        ${isFinished ? "bg-muted/40 border-border" : "bg-card border-border hover:border-primary/30"}`}
    >
      {/* Logo / initial */}
      {event.logo_url ? (
        <img
          src={event.logo_url}
          alt={event.name}
          className={`w-14 h-14 rounded-xl object-cover shrink-0 ${isFinished ? "grayscale opacity-70" : ""}`}
        />
      ) : (
        <div
          className="w-14 h-14 rounded-xl flex items-center justify-center text-white font-display font-bold text-xl shrink-0"
          style={{ backgroundColor: isFinished ? "#9ca3af" : (isValidHex(event.color_primary) ? event.color_primary : "#4F46E5") }}
        >
          {event.name?.[0]?.toUpperCase()}
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-display font-semibold text-base truncate">{event.name}</p>
          {isFinished && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted rounded-full px-2 py-0.5">
              <Lock className="w-3 h-3" /> Consulta
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <StatusBadge status={event.status} />
          {event.start_date && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="w-3 h-3" />
              {new Date(event.start_date).toLocaleDateString("pt-BR")}
            </span>
          )}
          {event.location && (
            <span className="text-xs text-muted-foreground truncate">· {event.location}</span>
          )}
        </div>
      </div>

      <div className="shrink-0 text-muted-foreground group-hover:text-primary transition-colors">
        <Clock className="w-5 h-5" />
      </div>
    </motion.div>
  );
}

export default function MeusEventos() {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const queryClient = useQueryClient();

  const handleRefresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["my_person"] }),
      queryClient.invalidateQueries({ queryKey: ["my_participants_email"] }),
      queryClient.invalidateQueries({ queryKey: ["my_participants_person"] }),
      queryClient.invalidateQueries({ queryKey: ["my_events_scoped"] }),
    ]);
  };

  // 1. Buscar Person vinculada ao user (não-admin) — scoped por email
  const { data: persons = [], isLoading: loadingPersons } = useQuery({
    queryKey: ["my_person", user?.id],
    queryFn: () => base44.entities.Person.filter({ contact_email: user?.email, is_active: true }),
    enabled: !!user && !admin,
  });

  // 2. Buscar participações por email — scoped (não-admin)
  const { data: participantsByEmail = [], isLoading: loadingByEmail } = useQuery({
    queryKey: ["my_participants_email", user?.email],
    queryFn: () => base44.entities.Participant.filter({ email: user?.email, is_deleted: false }),
    enabled: !!user && !admin,
  });

  // 3. Buscar participações vinculadas via person_id — scoped (não-admin)
  const personIds = persons.map((p) => p.id);
  const { data: participantsByPerson = [], isLoading: loadingByPerson } = useQuery({
    queryKey: ["my_participants_person", personIds.join(",")],
    queryFn: () => {
      if (!personIds.length) return [];
      return base44.entities.Participant.filter({ person_id: { $in: personIds }, is_deleted: false });
    },
    enabled: !!user && !admin && personIds.length > 0,
  });

  // 4. Resolver event IDs e buscar eventos — scoped
  const allMyParticipants = [...participantsByEmail, ...participantsByPerson];
  const myEventIds = admin ? null : new Set(allMyParticipants.map((p) => p.event_id));
  const eventIdList = myEventIds ? [...myEventIds] : [];

  const { data: scopedEvents = [], isLoading: loadingEvents } = useQuery({
    queryKey: ["my_events_scoped", admin ? "all" : eventIdList.join(",")],
    queryFn: async () => {
      if (admin) {
        return base44.entities.Event.filter({ is_deleted: false, status: { $in: ["active", "finished"] } });
      }
      if (!eventIdList.length) return [];
      return base44.entities.Event.filter({ id: { $in: eventIdList }, is_deleted: false });
    },
    enabled: !!user && (admin || eventIdList.length > 0),
  });

  const isLoading = admin ? loadingEvents : (loadingPersons || loadingByEmail || loadingByPerson || loadingEvents);

  const activeEvents = scopedEvents.filter((e) => e.status === "active");
  const finishedEvents = scopedEvents.filter((e) => e.status === "finished");

  if (isLoading) {
    return <ListSkeleton count={4} />;
  }

  return (
    <PullToRefresh onRefresh={handleRefresh}>
    <div className="space-y-8 max-w-2xl mx-auto">
      <PageHeader icon={Calendar} title="Meus Eventos" subtitle="Eventos em que você está cadastrado como participante." tone="primary" />

      {/* Ativos */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Eventos Ativos
        </h2>
        {activeEvents.length === 0 ? (
          <EmptyState icon={Calendar} title="Nenhum evento ativo" description="Você não está inscrito em nenhum evento ativo no momento." />
        ) : (
          <div className="space-y-3">
            {activeEvents.map((e, i) => (
              <EventCard key={e.id} event={e} index={i} isFinished={false} />
            ))}
          </div>
        )}
      </section>

      {/* Encerrados */}
      {finishedEvents.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Eventos Encerrados
          </h2>
          <div className="space-y-3">
            {finishedEvents.map((e, i) => (
              <EventCard key={e.id} event={e} index={i} isFinished />
            ))}
          </div>
        </section>
      )}
    </div>
    </PullToRefresh>
  );
}
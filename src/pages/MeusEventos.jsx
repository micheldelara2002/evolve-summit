/**
 * Página "Meus Eventos" para usuários não-admin.
 * Mostra apenas eventos active/finished em que o usuário tem Participant vinculado.
 */
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/AuthContext";
import { isAdmin } from "@/lib/access";
import { base44 } from "@/api/base44Client";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Calendar, Clock, Lock } from "lucide-react";
import StatusBadge from "@/components/admin/StatusBadge";

function EventCard({ event, index, isFinished }) {
  const navigate = useNavigate();
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.06 }}
      onClick={() => navigate(`/evento/${event.id}`)}
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
          style={{ backgroundColor: isFinished ? "#9ca3af" : (event.color_primary || "#4F46E5") }}
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

  // 1. Buscar Person vinculada ao user (não-admin)
  const { data: persons = [] } = useQuery({
    queryKey: ["my_person", user?.id],
    queryFn: () => base44.entities.Person.filter({ is_active: true }),
    enabled: !!user && !admin,
  });

  // 2. Buscar participações deste usuário (via e-mail match ou person_id) — não-admin apenas
  const { data: allParticipants = [] } = useQuery({
    queryKey: ["my_participants", user?.email],
    queryFn: () => base44.entities.Participant.filter({ is_deleted: false }),
    enabled: !!user && !admin,
  });

  // 3. Buscar todos os eventos ativos/finalizados
  const { data: allEvents = [], isLoading } = useQuery({
    queryKey: ["eventos_disponiveis"],
    queryFn: () => base44.entities.Event.filter({ is_deleted: false }),
    enabled: !!user,
  });

  // Admin vê todos os eventos active/finished; não-admin filtra por participação
  const myPersonIds = new Set(persons.filter((p) => p.contact_email === user?.email).map((p) => p.id));
  const myEventIds = admin
    ? null // null = sem restrição
    : new Set(
        allParticipants
          .filter((p) =>
            p.email === user?.email ||
            (p.person_id && myPersonIds.has(p.person_id))
          )
          .map((p) => p.event_id)
      );

  const activeEvents = allEvents.filter(
    (e) => e.status === "active" && (admin || myEventIds.has(e.id))
  );
  const finishedEvents = allEvents.filter(
    (e) => e.status === "finished" && (admin || myEventIds.has(e.id))
  );

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-7 h-7 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-2xl mx-auto">
      <div>
        <h1 className="text-2xl font-display font-bold">Meus Eventos</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Eventos em que você está cadastrado como participante.
        </p>
      </div>

      {/* Ativos */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Eventos Ativos
        </h2>
        {activeEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground bg-muted/40 rounded-xl px-4 py-6 text-center">
            Você não está inscrito em nenhum evento ativo no momento.
          </p>
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
  );
}
/**
 * Dashboard de resumo do parceiro — visível apenas para partner_manager / admin.
 * Cards: total de eventos, total de leads, total de palestras.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Calendar, Users, Mic } from "lucide-react";

export default function PartnerDashboard({ partnerId }) {
  // Eventos do partner
  const { data: eventPartners = [] } = useQuery({
    queryKey: ["dash_event_partners", partnerId],
    queryFn: async () => {
      const res = await base44.functions.invoke('getEventPartners', { partnerId });
      return res.data?.eventPartners || [];
    },
    enabled: !!partnerId,
  });

  // Leads do partner (todos os eventos)
  const { data: leads = [] } = useQuery({
    queryKey: ["dash_leads", partnerId],
    queryFn: async () => {
      const r = await base44.functions.invoke('getMyLeads', { partnerId });
      return r.data?.leads || [];
    },
    enabled: !!partnerId,
  });

  // Representatives do partner → person_ids
  const { data: reps = [] } = useQuery({
    queryKey: ["dash_reps", partnerId],
    queryFn: async () => {
      const res = await base44.functions.invoke('getPartnerRepresentatives', { partnerId });
      return (res.data?.representatives || []).filter((r) => r.is_active);
    },
    enabled: !!partnerId,
  });

  const repPersonIds = [...new Set(reps.map((r) => r.person_id).filter(Boolean))];

  // Participants que são speakers e vinculados a esses person_ids — query direcionada por person_id ($in)
  const { data: speakerParticipants = [] } = useQuery({
    queryKey: ["dash_speaker_participants", repPersonIds.join(",")],
    queryFn: async () => {
      if (!repPersonIds.length) return [];
      return base44.entities.Participant.filter({
        role_in_event: "speaker",
        person_id: { $in: repPersonIds },
        is_deleted: false,
      });
    },
    enabled: repPersonIds.length > 0,
  });

  const speakerParticipantIds = [...new Set(speakerParticipants.map((p) => p.id))];

  // Events do partner (autorização event-scoped via backend function).
  const partnerEventIds = [...new Set(eventPartners.map((ep) => ep.event_id))];
  // Sessions desses speakers — leitura via getEventSessions (autorização server-side)
  const { data: sessions = [] } = useQuery({
    queryKey: ["dash_sessions", speakerParticipantIds.join(","), partnerEventIds.join(",")],
    queryFn: async () => {
      if (!speakerParticipantIds.length || !partnerEventIds.length) return [];
      const res = await base44.functions.invoke('getEventSessions', { eventIds: partnerEventIds });
      const all = res.data?.sessions || [];
      // Filtro de apresentação: somente sessões dos speakers deste partner.
      return all.filter((s) => speakerParticipantIds.includes(s.speaker_id));
    },
    enabled: speakerParticipantIds.length > 0 && partnerEventIds.length > 0,
  });

  const cards = [
    { label: "Eventos", value: eventPartners.length, icon: Calendar, color: "text-violet-600 bg-violet-50 border-violet-200" },
    { label: "Leads", value: leads.length, icon: Users, color: "text-sky-600 bg-sky-50 border-sky-200" },
    { label: "Palestras", value: sessions.length, icon: Mic, color: "text-fuchsia-600 bg-fuchsia-50 border-fuchsia-200" },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {cards.map(({ label, value, icon: Icon, color }) => (
        <div key={label} className={`rounded-2xl border p-4 flex flex-col items-center gap-2 ${color}`}>
          <Icon className="w-5 h-5" />
          <span className="text-2xl font-display font-bold">{value}</span>
          <span className="text-xs font-medium opacity-80">{label}</span>
        </div>
      ))}
    </div>
  );
}
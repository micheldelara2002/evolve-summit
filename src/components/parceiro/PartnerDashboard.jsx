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
    queryFn: () => base44.entities.EventPartner.filter({ partner_id: partnerId, is_active: true, is_deleted: false }),
    enabled: !!partnerId,
  });

  // Leads do partner (todos os eventos)
  const { data: leads = [] } = useQuery({
    queryKey: ["dash_leads", partnerId],
    queryFn: () => base44.entities.Lead.filter({ partner_id: partnerId }),
    enabled: !!partnerId,
  });

  // Representatives do partner → person_ids
  const { data: reps = [] } = useQuery({
    queryKey: ["dash_reps", partnerId],
    queryFn: () => base44.entities.PartnerRepresentative.filter({ partner_id: partnerId, is_active: true, is_deleted: false }),
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

  // Sessions desses speakers — query direcionada por speaker_id ($in)
  const { data: sessions = [] } = useQuery({
    queryKey: ["dash_sessions", speakerParticipantIds.join(",")],
    queryFn: async () => {
      if (!speakerParticipantIds.length) return [];
      return base44.entities.Session.filter({
        speaker_id: { $in: speakerParticipantIds },
        is_deleted: false,
      });
    },
    enabled: speakerParticipantIds.length > 0,
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
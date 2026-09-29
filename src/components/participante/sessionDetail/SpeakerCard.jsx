/**
 * Card do palestrante no detalhe da sessão: foto + info e "Patrocinado por"
 * (quando o palestrante é representante de parceiro).
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { fetchEventParticipants } from "@/lib/participantApi";
import { fetchPersonsByIds } from "@/lib/personApi";
import { Mic, Building2 } from "lucide-react";

export default function SpeakerCard({ session }) {
  // Buscar person do speaker para foto
  const { data: speakerPerson } = useQuery({
    queryKey: ["speaker-person", session.speaker_id],
    queryFn: async () => {
      if (!session.speaker_id) return null;
      // speaker_id é Participant.id — resolvido via backend com escopo do evento
      const parts = await fetchEventParticipants(session.event_id, { participant_ids: [session.speaker_id] });
      const sp = parts[0];
      if (!sp?.person_id) return null;
      const persons = await fetchPersonsByIds([session.event_id], [sp.person_id]);
      return persons[0] ?? null;
    },
    enabled: !!session.speaker_id,
  });

  // Verificar se palestrante é partner_rep
  const { data: partnerRepInfo } = useQuery({
    queryKey: ["speaker-partner-rep", session.speaker_id, session.event_id],
    queryFn: async () => {
      if (!session.speaker_id) return null;
      const res = await base44.functions.invoke('getSpeakerPartner', { eventId: session.event_id, speakerParticipantId: session.speaker_id });
      return res.data?.partner || null;
    },
    enabled: !!session.speaker_id,
  });

  if (!session.speaker_name && !speakerPerson) return null;

  const photoUrl = speakerPerson?.photo_url;
  const displayName = session.speaker_name || speakerPerson?.full_name;

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-muted/30 border-b border-border">
      {/* Avatar */}
      <div className="shrink-0">
        {photoUrl ? (
          <img src={photoUrl} alt={displayName} className="w-12 h-12 rounded-full object-cover ring-2 ring-border" />
        ) : (
          <div className="w-12 h-12 rounded-full bg-primary/10 text-primary font-display font-bold text-lg flex items-center justify-center ring-2 ring-border">
            {displayName?.[0]?.toUpperCase() ?? "?"}
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <Mic className="w-3 h-3 text-muted-foreground shrink-0" />
          <p className="text-sm font-medium truncate">{displayName}</p>
        </div>
        {speakerPerson?.company && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">
            {speakerPerson.company}{speakerPerson.job_title ? ` · ${speakerPerson.job_title}` : ""}
          </p>
        )}
      </div>

      {/* Patrocinado por */}
      {partnerRepInfo && (
        <div className="shrink-0 flex flex-col items-center gap-1 text-center">
          <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Patrocinado por</span>
          {partnerRepInfo.logo_url ? (
            <img src={partnerRepInfo.logo_url} alt={partnerRepInfo.trade_name} className="h-8 max-w-[80px] object-contain" />
          ) : (
            <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Building2 className="w-3.5 h-3.5" />
              <span>{partnerRepInfo.trade_name}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
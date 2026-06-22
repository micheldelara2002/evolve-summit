/**
 * Informações de patrocínio do parceiro no evento:
 *  - Plano (Diamante, Ouro, Prata, Bronze, Apoiador)
 *  - Palestras relacionadas (sessions onde o speaker é representante do partner)
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Award, Mic } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const PLAN_LABELS = {
  diamante: "Diamante",
  ouro: "Ouro",
  prata: "Prata",
  bronze: "Bronze",
  apoiador: "Apoiador",
};

const PLAN_COLORS = {
  diamante: "bg-cyan-100 text-cyan-700 border-cyan-300",
  ouro: "bg-amber-100 text-amber-700 border-amber-300",
  prata: "bg-slate-100 text-slate-700 border-slate-300",
  bronze: "bg-orange-100 text-orange-700 border-orange-300",
  apoiador: "bg-emerald-100 text-emerald-700 border-emerald-300",
};

export default function PartnerSponsorshipTab({ eventId, partnerId }) {
  // EventPartner para obter o plano
  const { data: eventPartners = [] } = useQuery({
    queryKey: ["sponsorship_ep", eventId, partnerId],
    queryFn: () => base44.entities.EventPartner.filter({ event_id: eventId, partner_id: partnerId, is_deleted: false }),
    enabled: !!eventId && !!partnerId,
  });

  const eventPartner = eventPartners[0];
  const plan = eventPartner?.sponsorship_plan;

  // Representatives do partner → person_ids
  const { data: reps = [] } = useQuery({
    queryKey: ["sponsorship_reps", partnerId],
    queryFn: () => base44.entities.PartnerRepresentative.filter({ partner_id: partnerId, is_active: true, is_deleted: false }),
    enabled: !!partnerId,
  });

  const repPersonIds = [...new Set(reps.map((r) => r.person_id).filter(Boolean))];

  // Participants que são speakers e vinculados a esses person_ids neste evento
  const { data: speakerParticipants = [] } = useQuery({
    queryKey: ["sponsorship_speakers", eventId, repPersonIds.join(",")],
    queryFn: async () => {
      if (!repPersonIds.length) return [];
      const all = await base44.entities.Participant.filter({ event_id: eventId, role_in_event: "speaker", is_deleted: false });
      return all.filter((p) => repPersonIds.includes(p.person_id));
    },
    enabled: !!eventId && repPersonIds.length > 0,
  });

  const speakerIds = [...new Set(speakerParticipants.map((p) => p.id))];
  const speakerMap = Object.fromEntries(speakerParticipants.map((p) => [p.id, p]));

  // Sessions desses speakers no evento
  const { data: sessions = [] } = useQuery({
    queryKey: ["sponsorship_sessions", eventId, speakerIds.join(",")],
    queryFn: async () => {
      if (!speakerIds.length) return [];
      const all = await base44.entities.Session.filter({ event_id: eventId, is_deleted: false });
      return all.filter((s) => speakerIds.includes(s.speaker_id));
    },
    enabled: !!eventId && speakerIds.length > 0,
  });

  return (
    <div className="space-y-5">
      {/* Plano de patrocínio */}
      <div>
        <h2 className="text-base font-display font-semibold flex items-center gap-2">
          <Award className="w-4 h-4 text-orange-600" /> Plano de Patrocínio
        </h2>
        <Card className="mt-2">
          <CardContent className="py-4 flex items-center gap-3">
            {plan ? (
              <>
                <Badge className={`text-sm px-3 py-1 border ${PLAN_COLORS[plan] || ""}`}>
                  {PLAN_LABELS[plan] || plan}
                </Badge>
                <span className="text-sm text-muted-foreground">Plano ativo neste evento</span>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">Nenhum plano de patrocínio ativo neste evento.</span>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Palestras relacionadas */}
      <div>
        <h2 className="text-base font-display font-semibold flex items-center gap-2">
          <Mic className="w-4 h-4 text-fuchsia-600" /> Palestras do Parceiro
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5 mb-3">
          Palestras ministradas por representantes deste parceiro no evento.
        </p>

        {sessions.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <Mic className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">Nenhuma palestra encontrada.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => {
              const speaker = speakerMap[s.speaker_id];
              return (
                <Card key={s.id}>
                  <CardContent className="py-3 px-4">
                    <p className="font-medium text-sm">{s.title}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-xs text-muted-foreground">por {s.speaker_name || speaker?.full_name || "—"}</span>
                      {s.session_type && <Badge variant="outline" className="text-[10px] py-0">{s.session_type}</Badge>}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
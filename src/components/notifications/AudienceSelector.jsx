/**
 * Seletor de audiência com RBAC e contador estimado.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { getAllowedSegments } from "@/lib/notificationService";
import { getMyMemberships } from "@/lib/roleEngine";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Users } from "lucide-react";

const SEGMENT_LABELS = {
  all: "Todos",
  admin: "Administradores",
  gerente: "Gerentes",
  staff: "Staff / Equipe",
  palestrante: "Palestrantes",
  representante: "Representantes",
  attendee: "Participantes",
  my_leads: "Meus Leads",
  my_attendees: "Meus Participantes",
  partner_all_event: "Todos do Evento",
  partner_leads: "Leads do Parceiro",
};

export default function AudienceSelector({ user, scopeType, scopeEventId, value, onChange }) {
  // Papéis contextuais de evento (EventMembership) do usuário — carregados apenas
  // para escopo de evento, onde papéis não-admin são resolvidos contextualmente.
  const { data: memberships = [] } = useQuery({
    queryKey: ["my_memberships", user?.id],
    queryFn: () => getMyMemberships(user.id),
    enabled: !!user?.id && scopeType === "event" && !!scopeEventId,
  });

  const allowed = getAllowedSegments(user, scopeType, scopeEventId, memberships);

  // Simple modes that don't need multi-select
  const simpleModes = allowed.filter((s) => s === "my_leads" || s === "my_attendees" || s === "partner_all_event" || s === "partner_leads");
  const segmentModes = allowed.filter((s) => s !== "my_leads" && s !== "my_attendees" && s !== "partner_all_event" && s !== "partner_leads");

  // Estimate count
  const { data: participants = [] } = useQuery({
    queryKey: ["participants_est", scopeEventId],
    queryFn: () => scopeEventId
      ? base44.entities.Participant.filter({ event_id: scopeEventId, is_deleted: false, is_eligible: { $ne: false } })
      : base44.entities.User.list().then((users) => users.filter((u) => u.account_status !== "deleted")),
    enabled: true,
  });

  const estimateCount = () => {
    if (!value) return 0;
    if (value.type === "all") return participants.length;
    if (value.type === "my_leads" || value.type === "my_attendees") return "?";
    if (value.type === "segment" && value.segments?.length > 0) {
      if (value.segments.includes("all")) return participants.length;
      // rough estimate
      return Math.ceil(participants.length * (value.segments.length / 5));
    }
    return 0;
  };

  const handleTypeChange = (type) => {
    if (type === "all") onChange({ type: "all", segments: [] });
    else if (type === "my_leads") onChange({ type: "my_leads", segments: [] });
    else if (type === "my_attendees") onChange({ type: "my_attendees", segments: [] });
    else if (type === "partner_all_event") onChange({ type: "partner_all_event", segments: [] });
    else if (type === "partner_leads") onChange({ type: "partner_leads", segments: [] });
    else onChange({ type: "segment", segments: value?.segments || [] });
  };

  const toggleSegment = (seg) => {
    const current = value?.segments || [];
    const next = current.includes(seg) ? current.filter((s) => s !== seg) : [...current, seg];
    onChange({ type: "segment", segments: next });
  };

  // If user only has simple modes (representante / palestrante)
  if (simpleModes.length > 0 && segmentModes.length <= 1) {
    return (
      <div className="space-y-2">
        <Select value={value?.type || simpleModes[0]} onValueChange={handleTypeChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {allowed.map((s) => (
              <SelectItem key={s} value={s}>{SEGMENT_LABELS[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  const currentType = value?.type || "all";

  return (
    <div className="space-y-3">
      <Select value={currentType} onValueChange={handleTypeChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {segmentModes.includes("all") && <SelectItem value="all">Todos</SelectItem>}
          {segmentModes.filter((s) => s !== "all").length > 0 && (
            <SelectItem value="segment">Perfis específicos</SelectItem>
          )}
          {simpleModes.map((s) => (
            <SelectItem key={s} value={s}>{SEGMENT_LABELS[s]}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {currentType === "segment" && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <p className="text-xs font-medium text-muted-foreground mb-1">Selecionar perfis:</p>
          {segmentModes.filter((s) => s !== "all").map((seg) => (
            <div key={seg} className="flex items-center gap-2">
              <Checkbox
                id={`seg-${seg}`}
                checked={value?.segments?.includes(seg) || false}
                onCheckedChange={() => toggleSegment(seg)}
              />
              <Label htmlFor={`seg-${seg}`} className="font-normal cursor-pointer">
                {SEGMENT_LABELS[seg]}
              </Label>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Users className="w-3.5 h-3.5" />
        <span>~{estimateCount()} destinatários estimados</span>
        {estimateCount() > 0 && (
          <Badge variant="outline" className="text-xs px-1.5 py-0 ml-1">{estimateCount()}</Badge>
        )}
      </div>
    </div>
  );
}
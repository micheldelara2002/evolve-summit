/**
 * Solicitação de mentoria com o palestrante da sessão (uma solicitação ativa
 * por participante/sessão).
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { BookUser, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export default function MentorshipSection({ session, participant, isReadOnly }) {
  const queryClient = useQueryClient();
  const { data: existing = [] } = useQuery({
    queryKey: ["mentorship", session.id, participant?.id],
    queryFn: async () => {
      if (!participant?.id) return [];
      const res = await base44.functions.invoke('getMentorshipRequests', { participantId: participant.id, sessionId: session.id });
      return res.data?.mentorshipRequests || [];
    },
    enabled: !!participant?.id,
  });
  const alreadyRequested = existing.some((r) => r.status !== "cancelled");

  const requestMut = useMutation({
    mutationFn: () => base44.functions.invoke('saveMentorshipRequest', {
      eventId: session.event_id,
      sessionId: session.id,
      participantId: participant?.id,
      personId: participant?.person_id,
      mentorParticipantId: session.speaker_id || undefined,
      topic: session.title,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mentorship", session.id, participant?.id] });
      toast.success("Solicitação de mentoria enviada!");
    },
  });

  if (alreadyRequested) {
    return (
      <div className="flex items-center gap-2 text-sm text-emerald-600">
        <CheckCircle2 className="w-4 h-4" /> Solicitação enviada ao palestrante.
      </div>
    );
  }

  return (
    <Button variant="outline" className="w-full gap-2" disabled={isReadOnly || requestMut.isPending} onClick={() => requestMut.mutate()}>
      <BookUser className="w-4 h-4" />
      {requestMut.isPending ? "Enviando..." : "Quero Mentoria"}
    </Button>
  );
}
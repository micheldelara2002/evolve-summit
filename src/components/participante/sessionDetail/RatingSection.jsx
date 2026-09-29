/**
 * Avaliação da sessão: slider 0-10 + comentário opcional (upsert server-side,
 * participante resolvido no backend — Lote 4). Avaliar pontua via motor.
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { processAction } from "@/lib/scoringEngine";
import { manageSessionReview } from "@/lib/personApi";
import { sanitizeText } from "@/utils/sanitize";
import { Button } from "@/components/ui/button";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";

export default function RatingSection({ session, participant, isReadOnly }) {
  const queryClient = useQueryClient();
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");

  const { data: reviewData } = useQuery({
    queryKey: ["session-reviews", session.id, participant?.id],
    queryFn: () => manageSessionReview({ sessionId: session.id, action: "get" }),
    enabled: !!participant?.id,
  });
  const myReview = reviewData?.review || null;

  useEffect(() => {
    if (myReview) {
      setRating(myReview.rating);
      setComment(myReview.comment || "");
    }
  }, [myReview]);

  const submitMut = useMutation({
    mutationFn: () => {
      const safeComment = comment.trim() ? sanitizeText(comment.trim()) : undefined;
      // Lote 4 — upsert server-side (participante resolvido no backend)
      return manageSessionReview({ sessionId: session.id, action: "save", rating, comment: safeComment });
    },
    onSuccess: async () => {
      queryClient.invalidateQueries({ queryKey: ["session-reviews", session.id, participant?.id] });
      toast.success(myReview ? "Avaliação atualizada!" : "Avaliação enviada!");
      if (participant?.id) {
        await processAction({
          eventId: session.event_id,
          participantId: participant.id,
          personId: participant.person_id,
          acao: "avaliacao_sessao",
          refId: session.id,
        });
        queryClient.invalidateQueries({ queryKey: ["my_participant_points"] });
      }
    },
  });

  if (isReadOnly && !myReview) return <p className="text-xs text-muted-foreground">Evento encerrado.</p>;

  return (
    <div className="space-y-4">
      {myReview && (
        <div className="flex items-center gap-2 text-xs text-emerald-600 font-medium">
          <CheckCircle2 className="w-4 h-4" /> Avaliação registrada — você pode atualizar sua nota.
        </div>
      )}
      {/* Slider */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">Nota *</p>
          <span className="text-2xl font-display font-bold text-primary">{rating}<span className="text-sm font-normal text-muted-foreground">/10</span></span>
        </div>
        <input
          type="range"
          min={0}
          max={10}
          step={1}
          value={rating}
          onChange={(e) => setRating(Number(e.target.value))}
          className="w-full h-2 rounded-full appearance-none cursor-pointer accent-primary bg-muted"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>0</span>
          <span>5</span>
          <span>10</span>
        </div>
      </div>

      <div className="space-y-1">
        <textarea
          className="w-full rounded-xl border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
          rows={3}
          maxLength={500}
          placeholder="Comentário opcional..."
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <p className="text-xs text-right text-muted-foreground">{comment.length}/500</p>
      </div>
      <Button className="w-full" disabled={submitMut.isPending} onClick={() => submitMut.mutate()}>
        {submitMut.isPending ? "Enviando..." : myReview ? "Atualizar Avaliação" : "Enviar Avaliação"}
      </Button>
    </div>
  );
}
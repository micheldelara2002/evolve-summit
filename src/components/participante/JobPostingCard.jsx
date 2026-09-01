import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { UserPlus, Pencil, Trash2, Mail, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { t } from "@/lib/i18n";
import { sendConnectionRequest } from "@/lib/redeService";

const POSTIT_STYLES = [
  { card: "bg-primary/8 border-primary/25", accent: "text-primary" },
  { card: "bg-secondary/8 border-secondary/25", accent: "text-secondary" },
  { card: "bg-accent/8 border-accent/25", accent: "text-accent-foreground" },
  { card: "bg-success/8 border-success/25", accent: "text-success" },
];

const ROTATIONS = ["rotate-0", "rotate-1", "-rotate-1", "rotate-0", "-rotate-2", "rotate-2"];

function posterInitials(name) {
  if (!name) return "?";
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

export default function JobPostingCard({ job, personMap, myPerson, myParticipantId, canModerate, isReadOnly, onEdit }) {
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const posterPerson = personMap.get(job.person_id);
  const isOwner = myPerson?.id === job.person_id;
  const styleIdx = (job.id?.charCodeAt(0) || 0) % POSTIT_STYLES.length;
  const rotIdx = (job.id?.charCodeAt(1) || 0) % ROTATIONS.length;
  const postit = POSTIT_STYLES[styleIdx];
  const rotation = ROTATIONS[rotIdx];

  const handleConnect = async () => {
    if (!posterPerson || !myPerson) return;
    setConnecting(true);
    try {
      const result = await sendConnectionRequest({
        eventId: job.event_id,
        requesterPerson: myPerson,
        receiverPerson: posterPerson,
        requesterParticipantId: myParticipantId,
      });
      if (result.ok) {
        toast.success(result.reason === "auto_accepted" ? "Conexão aceita!" : "Pedido enviado!");
      } else {
        toast.info(
          result.reason === "already_connected" ? "Vocês já estão conectados" :
          result.reason === "already_pending" ? "Já existe um pedido pendente" :
          "Não foi possível enviar o pedido"
        );
      }
    } catch (e) {
      toast.error("Erro: " + e.message);
    } finally {
      setConnecting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(t("jobBoard.deleteConfirm"))) return;
    setDeleting(true);
    try {
      await base44.functions.invoke('deleteJobPosting', { id: job.id });
      queryClient.invalidateQueries({ queryKey: ["job_postings", job.event_id] });
      toast.success(t("jobBoard.deleteSuccess"));
    } catch (e) {
      toast.error("Erro: " + e.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={`rounded-2xl border ${postit.card} p-4 space-y-3 shadow-sm transition-transform hover:rotate-0 hover:scale-[1.02] ${rotation}`}>
      <h3 className={`font-display font-bold text-base leading-tight ${postit.accent}`}>{job.job_title}</h3>

      {job.description && (
        <p className="text-sm text-muted-foreground line-clamp-3">{job.description}</p>
      )}

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Mail className="w-3.5 h-3.5 shrink-0" />
        <a href={`mailto:${job.contact_email}`} className="hover:text-primary transition-colors truncate">{job.contact_email}</a>
      </div>

      <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/40">
        <div className="flex items-center gap-2 min-w-0">
          {posterPerson?.photo_url || job.poster_photo_url ? (
            <img
              src={posterPerson?.photo_url || job.poster_photo_url}
              alt={posterPerson?.full_name || job.poster_name}
              className="w-7 h-7 rounded-full object-cover shrink-0"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-primary/15 text-primary font-display font-bold text-xs flex items-center justify-center shrink-0">
              {posterInitials(posterPerson?.full_name || job.poster_name)}
            </div>
          )}
          <span className="text-xs text-muted-foreground truncate">{posterPerson?.full_name || job.poster_name}</span>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {!isOwner && !isReadOnly && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" disabled={connecting} onClick={handleConnect}>
              {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{t("jobBoard.connect")}</span>
            </Button>
          )}

          {isOwner && !isReadOnly && (
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => onEdit(job)} aria-label={t("jobBoard.edit")}>
              <Pencil className="w-3.5 h-3.5" />
            </Button>
          )}

          {(isOwner || canModerate) && !isReadOnly && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
              disabled={deleting}
              onClick={handleDelete}
              aria-label={t("jobBoard.delete")}
            >
              {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
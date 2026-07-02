import { useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { t } from "@/lib/i18n";

const MAX_DESC = 250;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function JobPostingForm({ open, onClose, eventId, participantId, personId, person, editingJob }) {
  const queryClient = useQueryClient();
  const [jobTitle, setJobTitle] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [description, setDescription] = useState("");

  const isEditing = !!editingJob;

  useEffect(() => {
    if (open) {
      setJobTitle(editingJob?.job_title || "");
      setContactEmail(editingJob?.contact_email || person?.contact_email || "");
      setDescription(editingJob?.description || "");
    }
  }, [open, editingJob, person]);

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!jobTitle.trim()) throw new Error(t("jobBoard.jobTitleRequired"));
      if (!EMAIL_RE.test(contactEmail)) throw new Error(t("jobBoard.invalidEmail"));

      const payload = {
        job_title: jobTitle.trim(),
        contact_email: contactEmail.trim(),
        description: description.trim().slice(0, MAX_DESC),
      };

      if (isEditing) {
        return base44.entities.JobPosting.update(editingJob.id, payload);
      }
      return base44.entities.JobPosting.create({
        ...payload,
        event_id: eventId,
        participant_id: participantId,
        person_id: personId,
        poster_name: person?.full_name || "",
        poster_photo_url: person?.photo_url || "",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["job_postings", eventId] });
      toast.success(isEditing ? t("jobBoard.editSuccess") : t("jobBoard.postSuccess"));
      onClose();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditing ? t("jobBoard.edit") : t("jobBoard.postJob")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("jobBoard.jobTitle")} *</Label>
            <Input
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder={t("jobBoard.jobTitlePlaceholder")}
              maxLength={120}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("jobBoard.contactEmail")} *</Label>
            <Input
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder={t("jobBoard.contactEmailPlaceholder")}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("jobBoard.description")}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESC))}
              placeholder={t("jobBoard.descriptionPlaceholder")}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              {description.length}/{MAX_DESC} · {t("jobBoard.descriptionHint")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("jobBoard.cancel")}</Button>
          <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
            {saveMut.isPending ? "..." : t("jobBoard.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
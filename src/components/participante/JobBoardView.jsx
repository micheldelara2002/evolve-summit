import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Briefcase, Plus, Lock } from "lucide-react";
import { t } from "@/lib/i18n";
import { isAdmin } from "@/lib/access";
import JobPostingCard from "./JobPostingCard";
import JobPostingForm from "./JobPostingForm";

export default function JobBoardView({ eventId, myPerson, myParticipant, user, isReadOnly }) {
  const [formOpen, setFormOpen] = useState(false);
  const [editingJob, setEditingJob] = useState(null);

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["job_postings", eventId],
    queryFn: () => base44.entities.JobPosting.filter({ event_id: eventId, is_deleted: false }),
  });

  const personIds = [...new Set(jobs.map((j) => j.person_id).filter(Boolean))];
  const { data: persons = [] } = useQuery({
    queryKey: ["job_persons", eventId, personIds.join(",")],
    queryFn: () => {
      if (!personIds.length) return [];
      return base44.entities.Person.filter({ id: { $in: personIds } });
    },
    enabled: jobs.length > 0 && personIds.length > 0,
  });

  const personMap = new Map(persons.map((p) => [p.id, p]));
  const canModerate =
    isAdmin(user) ||
    myParticipant?.role_in_event === "manager" ||
    myParticipant?.role_in_event === "team";

  const handleEdit = (job) => {
    setEditingJob(job);
    setFormOpen(true);
  };

  const handleClose = () => {
    setFormOpen(false);
    setEditingJob(null);
  };

  const sortedJobs = jobs
    .slice()
    .sort((a, b) => new Date(b.created_date) - new Date(a.created_date));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-display font-semibold flex items-center gap-2">
          <Briefcase className="w-5 h-5 text-primary" /> {t("jobBoard.title")}
        </h2>
        {!isReadOnly && (
          <Button size="sm" onClick={() => { setEditingJob(null); setFormOpen(true); }} className="gap-1.5">
            <Plus className="w-4 h-4" /> {t("jobBoard.postJob")}
          </Button>
        )}
      </div>

      {isReadOnly && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-warning/10 border border-warning/20 text-warning text-sm">
          <Lock className="w-4 h-4 shrink-0" /> {t("jobBoard.readOnlyHint")}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : sortedJobs.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
            <Briefcase className="w-8 h-8 text-muted-foreground/40" />
          </div>
          <h3 className="font-display font-semibold">{t("jobBoard.noJobs")}</h3>
          <p className="text-sm text-muted-foreground max-w-xs mx-auto">{t("jobBoard.noJobsDesc")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sortedJobs.map((job) => (
            <JobPostingCard
              key={job.id}
              job={job}
              personMap={personMap}
              myPerson={myPerson}
              myParticipantId={myParticipant?.id}
              canModerate={canModerate}
              isReadOnly={isReadOnly}
              onEdit={handleEdit}
            />
          ))}
        </div>
      )}

      <JobPostingForm
        open={formOpen}
        onClose={handleClose}
        eventId={eventId}
        participantId={myParticipant?.id}
        personId={myPerson?.id}
        person={myPerson}
        editingJob={editingJob}
      />
    </div>
  );
}
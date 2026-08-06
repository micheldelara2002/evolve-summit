import { useState } from "react";
import { Megaphone, Inbox } from "lucide-react";
import CallForPapersManager from "@/components/admin/cfp/CallForPapersManager";
import SubmissionsReview from "@/components/admin/cfp/SubmissionsReview";
import { cn } from "@/lib/utils";

/**
 * Aba principal do módulo Call for Papers dentro do EventDetail.
 * Alterna entre "Chamadas" (configuração) e "Submissões" (avaliação do curador).
 */
export default function CallForPapersTab({ eventId, hasAccess, user }) {
  const [view, setView] = useState("calls");

  const tabs = [
    { id: "calls", label: "Chamadas", icon: Megaphone },
    { id: "submissions", label: "Submissões", icon: Inbox },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 p-1 bg-muted rounded-xl w-fit">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = view === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setView(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors",
                active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {view === "calls" ? (
        <CallForPapersManager eventId={eventId} hasAccess={hasAccess} />
      ) : (
        <SubmissionsReview eventId={eventId} hasAccess={hasAccess} user={user} />
      )}
    </div>
  );
}
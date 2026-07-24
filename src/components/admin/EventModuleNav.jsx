import { Link } from "react-router-dom";
import { t } from "@/lib/i18n";
import {
  Users, Route, DoorOpen, Layout, Trophy,
  Handshake, ShoppingBag, Star, Bell,
  MessageSquare, Ticket, Award,
} from "lucide-react";

export default function EventModuleNav({ eventId }) {
  const sections = [
    {
      title: "Operação",
      modules: [
        { id: "people", label: t("adminSections.people"), icon: Users },
        { id: "partners", label: t("adminSections.partners"), icon: Handshake },
        { id: "certificates", label: t("adminSections.certificates"), icon: Award },
      ],
    },
    {
      title: "Conteúdo",
      modules: [
        { id: "tracks", label: t("adminSections.tracks"), icon: Route },
        { id: "rooms", label: t("adminSections.rooms"), icon: DoorOpen },
        { id: "sessions", label: t("adminSections.sessions"), icon: Layout },
        { id: "ranking", label: t("adminSections.ranking"), icon: Trophy },
      ],
    },
    {
      title: "Engajamento",
      modules: [
        { id: "store", label: t("adminSections.store"), icon: ShoppingBag },
        { id: "score", label: t("adminSections.score"), icon: Star },
        { id: "badges", label: t("adminSections.badges"), icon: Award },
        { id: "raffle", label: t("adminSections.raffle"), icon: Ticket },
        { id: "feedback", label: t("adminSections.feedback"), icon: MessageSquare },
        { id: "notifications", label: t("adminSections.notifications"), icon: Bell },
      ],
    },
  ];

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <div key={section.title} className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide px-1">
            {section.title}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {section.modules.map(({ id, label, icon: Icon }) => (
              <Link
                key={id}
                to={`/events/${eventId}/${id}`}
                className="flex items-center gap-2.5 p-3 rounded-xl border border-border bg-card hover:border-primary/40 hover:bg-surface transition-all"
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="text-sm font-medium truncate">{label}</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
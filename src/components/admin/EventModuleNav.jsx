import { Link } from "react-router-dom";
import { t } from "@/lib/i18n";
import {
  Users, Route, DoorOpen, Layout, Trophy,
  Handshake, ShoppingBag, Star, Bell,
  MessageSquare, Ticket, Award, Megaphone,
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
        { id: "cfp", label: t("adminSections.cfp"), icon: Megaphone },
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
    <div className="space-y-5">
      {sections.map((section) => (
        <div key={section.title} className="space-y-2.5">
          <h3 className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-1">
            {section.title}
          </h3>
          <div className="grid grid-cols-4 gap-2.5 sm:gap-3">
            {section.modules.map(({ id, label, icon: Icon }) => (
              <Link
                key={id}
                to={`/events/${eventId}/${id}`}
                className="flex flex-col items-center gap-1.5 group"
              >
                <div className="w-full aspect-square max-w-[68px] flex items-center justify-center rounded-2xl bg-card border border-border shadow-sm group-hover:border-primary/40 group-hover:shadow-md transition-all">
                  <Icon className="w-5 h-5 text-primary" strokeWidth={1.75} />
                </div>
                <span className="text-[10px] sm:text-[11px] font-medium text-center leading-tight line-clamp-2">
                  {label}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
import { t } from "@/lib/i18n";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { isAdmin, isPartnerManager } from "@/lib/access";
import { TrendingUp, Calendar, Shield, Bell, Users, Building2, ArrowRight, Mic, Handshake } from "lucide-react";

const TONE_CLASSES = {
  primary: "bg-primary/10 text-primary",
  secondary: "bg-secondary/15 text-secondary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

const ADMIN_CARDS = [
  { key: "meusEventos", icon: Calendar, tone: "primary", href: "/meus-eventos" },
  { key: "eventManagement", icon: Calendar, tone: "secondary", href: "/events" },
  { key: "people", icon: Users, tone: "success", href: "/admin/people" },
  { key: "partners", icon: Building2, tone: "warning", href: "/admin/partners" },
  { key: "notifications", icon: Bell, tone: "destructive", href: "/notifications" },
  { key: "business", icon: TrendingUp, tone: "primary", href: "/business" },
  { key: "audit", icon: Shield, tone: "warning", href: "/audit" },
];

const USER_CARDS = [
  { key: "meusEventos", icon: Calendar, tone: "primary", href: "/meus-eventos" },
];

const SPEAKER_CARD = {
  key: "painelPalestrante",
  icon: Mic,
  tone: "secondary",
  href: "/painel-palestrante",
  label: "Painel do Palestrante",
};

const PARTNER_CARD = {
  key: "painelParceiro",
  icon: Handshake,
  tone: "warning",
  href: "/painel-parceiro",
  label: "Painel do Parceiro",
};

const ROLE_LABELS = { admin: "Admin Global", member: "Membro", partner_manager: "Gestor Parceiro" };

export default function AdminHome() {
  const { user } = useAuth();
  const admin = isAdmin(user);

  const { data: participantRoles } = useQuery({
    queryKey: ["home-role-check", user?.person_id, user?.email],
    queryFn: async () => {
      const all = await base44.entities.Participant.filter({ is_deleted: false });
      const mine = all.filter(
        (p) => p.person_id === user?.person_id || p.email === user?.email
      );
      return {
        isSpeaker: mine.some((p) => p.role_in_event === "speaker"),
        isPartnerRep: mine.some((p) => p.role_in_event === "partner_rep"),
      };
    },
    enabled: !!user,
  });

  const baseCards = admin ? ADMIN_CARDS : USER_CARDS;
  let cards = [...baseCards];
  if (admin || participantRoles?.isSpeaker) {
    if (!cards.find((c) => c.key === "painelPalestrante")) cards = [...cards, SPEAKER_CARD];
  }
  if (admin || participantRoles?.isPartnerRep || isPartnerManager(user)) {
    if (!cards.find((c) => c.key === "painelParceiro")) cards = [...cards, PARTNER_CARD];
  }

  const title = admin ? t("home.title") : "Início";
  const greeting = admin ? "Bem-vindo de volta" : "Olá";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-display font-bold">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {greeting}, <span className="text-foreground font-medium">{user?.full_name}</span> · {ROLE_LABELS[user?.role] ?? "Participante"}
        </p>
      </div>

      {/* Quick actions grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map(({ key, icon: Icon, tone, href, label }) => (
          <Link key={key} to={href} className="no-underline group">
            <div className="flex items-center gap-4 p-4 rounded-xl border border-border bg-card hover:border-primary/40 hover:bg-surface transition-all cursor-pointer h-full">
              <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${TONE_CLASSES[tone] || TONE_CLASSES.primary}`}>
                <Icon className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-display font-semibold text-sm">
                  {label || t(`home.${key}`) || key}
                </p>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all shrink-0" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
import { t } from "@/lib/i18n";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import PullToRefresh from "@/components/ui/PullToRefresh";
import { isAdmin, isPartnerManager } from "@/lib/access";
import { TrendingUp, Calendar, Shield, Bell, Users, Building2, Mic, Handshake, Megaphone, Award } from "lucide-react";

const TONE_CLASSES = {
  primary: "bg-primary/10 text-primary",
  secondary: "bg-secondary/15 text-secondary",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

// ── Card definitions by section ──────────────────────────────────────────────
const MY_AREA_CARDS = [
  { key: "meusEventos", icon: Calendar, tone: "primary", href: "/my-events" },
  { key: "callForPapers", icon: Megaphone, tone: "secondary", href: "/cfp", label: "Call for Papers" },
  { key: "premiacao", icon: Award, tone: "success", href: "/awards", label: "Premiação" },
];

const SPEAKER_CARD = {
  key: "painelPalestrante",
  icon: Mic,
  tone: "secondary",
  href: "/speaker-dashboard",
  label: "Painel do Palestrante",
};

const PARTNER_CARD = {
  key: "painelParceiro",
  icon: Handshake,
  tone: "warning",
  href: "/partner-dashboard",
  label: "Painel do Parceiro",
};

const REVIEWER_CARD = {
  key: "painelAvaliador",
  icon: Award,
  tone: "success",
  href: "/reviewer-dashboard",
  label: "Painel do Avaliador",
};

const OPERATIONS_CARDS = [
  { key: "business", icon: TrendingUp, tone: "primary", href: "/business", label: "Indicadores" },
  { key: "notifications", icon: Bell, tone: "destructive", href: "/notifications" },
  { key: "audit", icon: Shield, tone: "warning", href: "/audit" },
];

const MANAGEMENT_CARDS = [
  { key: "eventManagement", icon: Calendar, tone: "secondary", href: "/events", label: "Gestão de Eventos" },
  { key: "people", icon: Users, tone: "success", href: "/people", label: "Gestão de Pessoas" },
  { key: "partners", icon: Building2, tone: "warning", href: "/partner", label: "Gestão de Parceiros" },
];

const ROLE_LABELS = { admin: "Admin Global", user: "Membro" };

export default function AdminHome() {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const queryClient = useQueryClient();

  const handleRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["home-role-check"] });
  };

  const { data: participantRoles, isLoading: isLoadingRoles } = useQuery({
    queryKey: ["home-role-check", user?.id, user?.person_id, user?.email],
    queryFn: async () => {
      const [mine, memberships, mySubs] = await Promise.all([
        base44.entities.Participant.filter({ email: user?.email, is_deleted: false }),
        user?.id
          ? base44.entities.EventMembership.filter({ user_id: user.id, is_active: true, is_deleted: false })
          : Promise.resolve([]),
        user?.person_id
          ? base44.entities.Submission.filter({ person_id: user.person_id, is_deleted: false })
          : Promise.resolve([]),
      ]);
      return {
        isSpeaker: mine.some((p) => p.role_in_event === "speaker") || memberships.some((m) => m.role === "speaker"),
        isPartnerRep: mine.some((p) => p.role_in_event === "partner_rep") || memberships.some((m) => m.role === "partner_rep"),
        isReviewer: memberships.some((m) => m.role === "reviewer"),
        hasSubmissions: mySubs.length > 0,
      };
    },
    enabled: !!user,
  });

  // ── Build "Minha área" section (available to all users) ───────────────────
  const myAreaCards = [...MY_AREA_CARDS];
  if (admin || participantRoles?.isSpeaker || participantRoles?.hasSubmissions) {
    if (!myAreaCards.find((c) => c.key === "painelPalestrante")) myAreaCards.push(SPEAKER_CARD);
  }
  if (admin || participantRoles?.isPartnerRep || isPartnerManager(user)) {
    if (!myAreaCards.find((c) => c.key === "painelParceiro")) myAreaCards.push(PARTNER_CARD);
  }
  if (admin || participantRoles?.isReviewer) {
    if (!myAreaCards.find((c) => c.key === "painelAvaliador")) myAreaCards.push(REVIEWER_CARD);
  }

  // Enquanto resolve papéis (não-admin, não-partner_manager), mostra skeletons para evitar flash
  const myAreaLoading = !admin && !isPartnerManager(user) && isLoadingRoles;

  // ── Admin-only sections ────────────────────────────────────────────────────
  const operationsCards = admin ? OPERATIONS_CARDS : [];
  const managementCards = admin ? MANAGEMENT_CARDS : [];

  const sections = [
    { title: "Minha área", cards: myAreaCards },
    { title: "Operações", cards: operationsCards },
    { title: "Gestão", cards: managementCards },
  ].filter((s) => s.cards.length > 0);

  const title = admin ? t("home.title") : "Início";
  const greeting = admin ? "Bem-vindo de volta" : "Olá";

  return (
    <PullToRefresh onRefresh={handleRefresh}>
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-display font-bold">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {greeting}, <span className="text-foreground font-medium">{user?.full_name}</span> · {admin ? "Admin Global" : isPartnerManager(user) ? "Gestor Parceiro" : "Membro"}
        </p>
      </div>

      {/* Sectioned icon grids */}
      {sections.map((section) => (
        <div key={section.title} className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{section.title}</h2>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {section.cards.map(({ key, icon: Icon, tone, href, label }) => (
              <Link key={key} to={href} className="no-underline group touch-manipulation">
                <div className="flex flex-col items-center gap-2 p-3 sm:p-4 rounded-xl border border-border bg-card hover:border-primary/40 hover:shadow-md transition-all cursor-pointer h-full">
                  <div className={`w-11 h-11 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center shrink-0 ${TONE_CLASSES[tone] || TONE_CLASSES.primary}`}>
                    <Icon className="w-5 h-5" strokeWidth={1.75} />
                  </div>
                  <span className="text-[11px] sm:text-xs font-medium text-center leading-tight line-clamp-2 min-h-[2em] flex items-center">
                    {label || t(`home.${key}`) || key}
                  </span>
                </div>
              </Link>
            ))}
            {section.title === "Minha área" && myAreaLoading && (
              <>
                {[0, 1].map((i) => (
                  <div key={`skeleton-${i}`} className="flex flex-col items-center gap-2 p-3 sm:p-4 rounded-xl border border-border bg-card animate-pulse">
                    <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-muted shrink-0" />
                    <div className="h-3 w-14 bg-muted/60 rounded" />
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
    </PullToRefresh>
  );
}
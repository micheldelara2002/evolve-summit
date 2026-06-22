import { t } from "@/lib/i18n";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { isAdmin, isPartnerManager } from "@/lib/access";
import { Activity, TrendingUp, Calendar, Shield, Bell, Users, Building2, ArrowRight, Mic, Handshake } from "lucide-react";
import { motion } from "framer-motion";

const ADMIN_CARDS = [
  { key: "meusEventos",     icon: Calendar,   color: "bg-violet-50 text-violet-700 border-violet-200",    iconColor: "text-violet-600",  href: "/meus-eventos" },
  { key: "eventManagement", icon: Calendar,   color: "bg-indigo-50 text-indigo-700 border-indigo-200",    iconColor: "text-indigo-600",  href: "/events" },
  { key: "people",          icon: Users,      color: "bg-teal-50 text-teal-700 border-teal-200",          iconColor: "text-teal-600",    href: "/admin/people" },
  { key: "partners",        icon: Building2,  color: "bg-orange-50 text-orange-700 border-orange-200",    iconColor: "text-orange-600",  href: "/admin/partners" },
  { key: "notifications",   icon: Bell,       color: "bg-rose-50 text-rose-700 border-rose-200",          iconColor: "text-rose-600",    href: "/notifications" },
  { key: "business",        icon: TrendingUp, color: "bg-sky-50 text-sky-700 border-sky-200",             iconColor: "text-sky-600",     href: "/business" },
  { key: "audit",           icon: Shield,     color: "bg-amber-50 text-amber-700 border-amber-200",       iconColor: "text-amber-600",   href: "/audit" },
  { key: "systemHealth",    icon: Activity,   color: "bg-emerald-50 text-emerald-700 border-emerald-200", iconColor: "text-emerald-600", href: "/health" },
];

const USER_CARDS = [
  { key: "meusEventos", icon: Calendar, color: "bg-violet-50 text-violet-700 border-violet-200", iconColor: "text-violet-600", href: "/meus-eventos" },
];

const SPEAKER_CARD = {
  key: "painelPalestrante",
  icon: Mic,
  color: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200",
  iconColor: "text-fuchsia-600",
  href: "/painel-palestrante",
  label: "Painel do Palestrante",
};

const PARTNER_CARD = {
  key: "painelParceiro",
  icon: Handshake,
  color: "bg-orange-50 text-orange-700 border-orange-200",
  iconColor: "text-orange-600",
  href: "/painel-parceiro",
  label: "Painel do Parceiro",
};

const ROLE_LABELS = { admin: "Admin Global", member: "Membro", partner_manager: "Gestor Parceiro" };

export default function AdminHome() {
  const { user } = useAuth();
  const admin = isAdmin(user);

  // Verificar se o usuário é palestrante em algum evento
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
  // Admin sempre vê todos os cards
  if (admin || participantRoles?.isSpeaker) {
    if (!cards.find((c) => c.key === "painelPalestrante")) cards = [...cards, SPEAKER_CARD];
  }
  if (admin || participantRoles?.isPartnerRep || isPartnerManager(user)) {
    if (!cards.find((c) => c.key === "painelParceiro")) cards = [...cards, PARTNER_CARD];
  }

  const title = admin ? t("home.title") : "Início";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold">{title}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {user?.full_name} · {ROLE_LABELS[user?.role] ?? "Participante"}
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map(({ key, icon: IconComp, color, iconColor, href, label }, i) => (
          <Link key={key} to={href} className="no-underline">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.07 }}
              className={`flex items-center gap-4 p-5 rounded-2xl border cursor-pointer hover:shadow-md transition-shadow ${color}`}
            >
              <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-white/70 shrink-0">
                <IconComp className={`w-6 h-6 ${iconColor}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-display font-semibold text-base">
                  {label || t(`home.${key}`) || key}
                </p>
              </div>
              <ArrowRight className="w-5 h-5 opacity-60 shrink-0" />
            </motion.div>
          </Link>
        ))}
      </div>
    </div>
  );
}
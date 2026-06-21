import { t } from "@/lib/i18n";
import { Link } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { isAdmin } from "@/lib/access";
import { Activity, TrendingUp, Calendar, Shield, Bell, Users, Building2, ArrowRight } from "lucide-react";
import { motion } from "framer-motion";

const ADMIN_CARDS = [
  { key: "systemHealth",    icon: Activity,   color: "bg-emerald-50 text-emerald-700 border-emerald-200", iconColor: "text-emerald-600", href: "/health" },
  { key: "business",        icon: TrendingUp, color: "bg-sky-50 text-sky-700 border-sky-200",             iconColor: "text-sky-600",     href: "/business" },
  { key: "eventManagement", icon: Calendar,   color: "bg-violet-50 text-violet-700 border-violet-200",    iconColor: "text-violet-600",  href: "/events" },
  { key: "audit",           icon: Shield,     color: "bg-amber-50 text-amber-700 border-amber-200",       iconColor: "text-amber-600",   href: "/audit" },
  { key: "notifications",   icon: Bell,       color: "bg-rose-50 text-rose-700 border-rose-200",          iconColor: "text-rose-600",    href: "/notifications" },
  { key: "people",          icon: Users,      color: "bg-teal-50 text-teal-700 border-teal-200",          iconColor: "text-teal-600",    href: "/admin/people" },
  { key: "partners",        icon: Building2,  color: "bg-orange-50 text-orange-700 border-orange-200",    iconColor: "text-orange-600",  href: "/admin/partners" },
];

const USER_CARDS = [
  { key: "meusEventos", icon: Calendar, color: "bg-violet-50 text-violet-700 border-violet-200", iconColor: "text-violet-600", href: "/meus-eventos" },
];

const ROLE_LABELS = { admin: "Admin Global", member: "Membro", partner_manager: "Gestor Parceiro" };

export default function AdminHome() {
  const { user } = useAuth();
  const admin = isAdmin(user);
  const cards = admin ? ADMIN_CARDS : USER_CARDS;
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
        {cards.map(({ key, icon: Icon, color, iconColor, href }, i) => (
          <Link key={key} to={href} className="no-underline">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.07 }}
              className={`flex items-center gap-4 p-5 rounded-2xl border cursor-pointer hover:shadow-md transition-shadow ${color}`}
            >
              <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-white/70 shrink-0">
                <Icon className={`w-6 h-6 ${iconColor}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-display font-semibold text-base">{t(`home.${key}`) || key}</p>
              </div>
              <ArrowRight className="w-5 h-5 opacity-60 shrink-0" />
            </motion.div>
          </Link>
        ))}
      </div>
    </div>
  );
}
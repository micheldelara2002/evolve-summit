import { Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Calendar, Bell, User, Handshake, Building2 } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { isAdmin, isPartnerManager } from "@/lib/access";
import { t } from "@/lib/i18n";

function getNavItems(user) {
  if (isAdmin(user)) {
    return [
      { path: "/", icon: LayoutDashboard, label: t("nav.home") },
      { path: "/events", icon: Calendar, label: t("nav.events") },
      { path: "/notifications", icon: Bell, label: t("nav.notifications") },
      { path: "/profile", icon: User, label: "Perfil" },
    ];
  }
  if (isPartnerManager(user)) {
    return [
      { path: "/", icon: LayoutDashboard, label: t("nav.home") },
      { path: "/painel-parceiro", icon: Handshake, label: "Painel" },
      { path: "/admin/partners", icon: Building2, label: "Empresa" },
      { path: "/profile", icon: User, label: "Perfil" },
    ];
  }
  return [
    { path: "/", icon: LayoutDashboard, label: t("nav.home") },
    { path: "/meus-eventos", icon: Calendar, label: "Meus Eventos" },
    { path: "/profile", icon: User, label: "Perfil" },
  ];
}

export default function BottomNav() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const items = getNavItems(user);

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-card/95 backdrop-blur-xl border-t border-border pb-safe"
      aria-label="Navegação principal"
    >
      <div className="flex items-stretch justify-around h-16">
        {items.map(({ path, icon: Icon, label }) => {
          const isActive = pathname === path || (path !== "/" && pathname.startsWith(path));
          return (
            <Link
              key={path}
              to={path}
              className="flex flex-col items-center justify-center gap-1 flex-1 min-w-0 text-muted-foreground transition-colors focus-visible:outline-none focus-visible:text-primary"
              aria-current={isActive ? "page" : undefined}
            >
              <span
                className={`flex items-center justify-center w-8 h-8 rounded-lg transition-all ${
                  isActive ? "bg-primary/15 text-primary glow-primary-sm" : ""
                }`}
              >
                <Icon className="w-5 h-5" />
              </span>
              <span className={`text-[10px] font-medium leading-none truncate max-w-full px-1 ${isActive ? "text-foreground" : ""}`}>
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
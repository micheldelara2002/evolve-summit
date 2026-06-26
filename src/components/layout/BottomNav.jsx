import { Link, useLocation } from "react-router-dom";
import { LayoutDashboard, Calendar, Users, QrCode } from "lucide-react";
import { t } from "@/lib/i18n";

const NAV_ITEMS = [
  { path: "/", icon: LayoutDashboard, labelKey: "nav.home" },
  { path: "/meus-eventos", icon: Calendar, labelKey: "nav.events" },
  { path: "/rede", icon: Users, labelKey: "nav.network" },
  { path: "/qr-scan", icon: QrCode, labelKey: "nav.scanQR" },
];

export default function BottomNav() {
  const { pathname } = useLocation();

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-card/95 backdrop-blur-xl border-t border-border pb-safe"
      aria-label="Navegação principal"
    >
      <div className="flex items-stretch justify-around h-16">
        {NAV_ITEMS.map(({ path, icon: Icon, labelKey }) => {
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
                {t(labelKey)}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
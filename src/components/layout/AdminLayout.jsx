import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { t } from "@/lib/i18n";
import { isAdmin, isPartnerManager } from "@/lib/access";
import { LayoutDashboard, Calendar, Shield, Bell, Handshake, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useUnreadCount } from "@/components/notifications/NotificationInbox";
import NotificationInbox from "@/components/notifications/NotificationInbox";
import BottomNav from "@/components/layout/BottomNav";
import ScrollRestoration from "@/components/layout/ScrollRestoration";

const ADMIN_NAV = [
  { path: "/", icon: LayoutDashboard, label: "nav.home" },
  { path: "/events", icon: Calendar, label: "nav.events" },
  { path: "/notifications", icon: Bell, label: "nav.notifications" },
  { path: "/audit", icon: Shield, label: "nav.audit" },
];

const USER_NAV = [
  { path: "/", icon: LayoutDashboard, label: "nav.home" },
  { path: "/my-events", icon: Calendar, label: "Meus Eventos" },
];

const PARTNER_MANAGER_NAV = [
  { path: "/", icon: LayoutDashboard, label: "nav.home" },
  { path: "/partner-dashboard", icon: Handshake, label: "Painel do Parceiro" },
  { path: "/partner", icon: Building2, label: "Minha Empresa" },
];

export default function AdminLayout() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const navItems = isAdmin(user) ? ADMIN_NAV : isPartnerManager(user) ? PARTNER_MANAGER_NAV : USER_NAV;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-50 bg-card/80 backdrop-blur-xl border-b border-border pt-safe">
        <div className="flex items-center justify-between px-4 h-14">
          <Link to="/" className="flex items-center gap-2 min-w-0 rounded-lg px-1 touch-manipulation" style={{ minHeight: 44 }}>
            <img
              src="https://media.base44.com/images/public/6a2c618daec1758ff2122225/93082474a_logoevolvesummittransparente.png"
              alt="Logo"
              className="w-8 h-8 object-contain shrink-0"
            />
            <span className="font-display font-bold text-sm sm:text-lg truncate">{t("app.name")}</span>
          </Link>

          <div className="flex items-center shrink-0 relative z-10 gap-1">
            <UserChip user={user} />
            <InboxBell />
          </div>
        </div>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1 px-4 pb-2" aria-label="Navegação desktop">
          {navItems.map((item) => {
            const isActive = pathname === item.path || (item.path !== "/" && pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.label.includes(".") ? t(item.label) : item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      {/* Main content */}
      <main className="flex-1 p-4 md:p-6 max-w-7xl mx-auto w-full pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-6">
        <Outlet />
      </main>

      {/* Mobile bottom navigation */}
      <BottomNav />
      <ScrollRestoration />
    </div>
  );
}

function UserChip({ user }) {
  const navigate = useNavigate();
  const initials = user?.full_name
    ? user.full_name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "?";
  const roleLabel = isAdmin(user) ? "Admin" : isPartnerManager(user) ? "Gestor Parceiro" : "Membro";

  return (
    <button
      type="button"
      onClick={() => navigate("/profile")}
      aria-label="Ver meu perfil"
      className="flex items-center justify-center rounded-lg hover:bg-muted active:bg-muted transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-manipulation"
      style={{ minWidth: 44, minHeight: 44 }}
    >
      {user?.photo_url ? (
        <img src={user.photo_url} alt={user.full_name} className="w-8 h-8 rounded-full object-cover ring-1 ring-border" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-primary/10 text-primary text-xs font-display font-bold flex items-center justify-center">
          {initials}
        </div>
      )}
    </button>
  );
}

function InboxBell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  const isMobile = useIsMobile();

  const trigger = (
    <Button
      variant="ghost"
      size="icon"
      className="relative h-11 w-11 shrink-0 touch-manipulation active:bg-muted rounded-lg"
      aria-label="Notificações"
    >
      <Bell className="w-5 h-5" />
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-destructive text-[10px] text-destructive-foreground flex items-center justify-center font-bold">
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </Button>
  );

  // Mobile: bottom Sheet (full-width, no fixed 384px overflow). Desktop: keep Popover.
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="h-[80vh] p-0 rounded-t-2xl [&>button:first-child]:hidden"
        >
          <NotificationInbox onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <NotificationInbox onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
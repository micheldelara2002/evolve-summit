import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { base44 } from "@/api/base44Client";
import { t } from "@/lib/i18n";
import { isAdmin } from "@/lib/access";
import { LayoutDashboard, Calendar, Shield, LogOut, Menu, X, ChevronRight, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useState } from "react";
import { useUnreadCount } from "@/components/notifications/NotificationInbox";
import NotificationInbox from "@/components/notifications/NotificationInbox";

const ADMIN_NAV = [
  { path: "/", icon: LayoutDashboard, label: "nav.home" },
  { path: "/events", icon: Calendar, label: "nav.events" },
  { path: "/notifications", icon: Bell, label: "nav.notifications" },
  { path: "/audit", icon: Shield, label: "nav.audit" },
];

const USER_NAV = [
  { path: "/", icon: LayoutDashboard, label: "nav.home" },
  { path: "/meus-eventos", icon: Calendar, label: "Meus Eventos" },
];

export default function AdminLayout() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navItems = isAdmin(user) ? ADMIN_NAV : USER_NAV;

  const handleLogout = () => {
    base44.auth.logout("/login");
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-50 bg-card/80 backdrop-blur-xl border-b border-border">
        <div className="flex items-center justify-between px-4 h-14">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"}
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen((v) => !v)}
            >
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </Button>
            <Link to="/" className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
                <span className="text-primary-foreground font-display font-bold text-sm">ES</span>
              </div>
              <span className="font-display font-bold text-lg hidden sm:block">{t("app.name")}</span>
            </Link>
          </div>

          <div className="flex items-center gap-2">
            {/* Avatar + nome clicável → /profile */}
            <UserChip user={user} />
            {/* Inbox bell */}
            <InboxBell />
            <Button variant="ghost" size="icon" onClick={handleLogout} title={t("nav.logout")}>
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-1 px-4 pb-2">
          {navItems.map((item) => {
            const isActive = pathname === item.path || (item.path !== "/" && pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-primary text-primary-foreground"
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

      {/* Mobile nav overlay */}
      <div
        className={`fixed inset-0 z-40 md:hidden transition-all duration-200 ${mobileOpen ? "pointer-events-auto" : "pointer-events-none"}`}
        aria-hidden={!mobileOpen}
      >
        {/* Backdrop */}
        <div
          className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${mobileOpen ? "opacity-100" : "opacity-0"}`}
          onClick={() => setMobileOpen(false)}
        />
        {/* Drawer */}
        <nav
          className={`absolute left-0 top-14 w-64 bg-card border-r border-border h-[calc(100vh-3.5rem)] p-3 space-y-1 shadow-xl transition-transform duration-200 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
          aria-label="Menu de navegação"
        >
          {navItems.map((item) => {
            const isActive = pathname === item.path || (item.path !== "/" && pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <div className="flex items-center gap-3">
                  <item.icon className="w-5 h-5" />
                  {item.label.includes(".") ? t(item.label) : item.label}
                </div>
                <ChevronRight className="w-4 h-4 opacity-40" />
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Main content */}
      <main className="flex-1 p-4 md:p-6 max-w-7xl mx-auto w-full">
        <Outlet />
      </main>
    </div>
  );
}

function UserChip({ user }) {
  const navigate = useNavigate();
  const initials = user?.full_name
    ? user.full_name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "?";
  const roleLabel = user?.role === "admin" ? "Admin" : user?.role === "partner_manager" ? "Gestor Parceiro" : "Membro";

  return (
    <button
      type="button"
      onClick={() => navigate("/profile")}
      aria-label="Ver meu perfil"
      className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-muted transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {user?.photo_url ? (
        <img src={user.photo_url} alt={user.full_name} className="w-7 h-7 rounded-full object-cover ring-1 ring-border" />
      ) : (
        <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-display font-bold flex items-center justify-center">
          {initials}
        </div>
      )}
      <div className="text-right hidden sm:block">
        <p className="text-sm font-medium leading-none">{user?.full_name}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{roleLabel}</p>
      </div>
    </button>
  );
}

function InboxBell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount(); // já usa refetchInterval 30s + subscrição RT

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="w-4 h-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-destructive text-[10px] text-white flex items-center justify-center font-bold">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <NotificationInbox onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}
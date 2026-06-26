import { Toaster } from "@/components/ui/toaster";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClientInstance } from "@/lib/query-client";
import { BrowserRouter as Router, Route, Routes, Navigate, useParams, useLocation } from "react-router-dom";
import PageNotFound from "./lib/PageNotFound";
import { AuthProvider, useAuth } from "@/lib/AuthContext";
import UserNotRegisteredError from "@/components/UserNotRegisteredError";
import ProtectedRoute from "@/components/ProtectedRoute";
import AdminRoute from "@/components/AdminRoute";

// Auth pages
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";

// Layout
import AdminLayout from "@/components/layout/AdminLayout";

// Pages
import AdminHome from "@/pages/AdminHome";
import BusinessDashboard from "@/pages/BusinessDashboard";
import EventsList from "@/pages/EventsList";
import EventCreate from "@/pages/EventCreate";
import EventEdit from "@/pages/EventEdit";
import EventDetail from "@/pages/EventDetail";
import AuditLog from "@/pages/AuditLog";
import AdminNotifications from "@/pages/AdminNotifications";
import NotificationMetrics from "@/pages/NotificationMetrics";
import AdminPeoplePlaceholder from "@/pages/AdminPeoplePlaceholder";
import AdminPartners from "@/pages/AdminPartners";
import UserProfile from "@/pages/UserProfile";
import UserProfileEdit from "@/pages/UserProfileEdit";
import MeusEventos from "@/pages/MeusEventos";
import EventoParticipante from "@/pages/EventoParticipante";
import PainelPalestrante from "@/pages/PainelPalestrante";
import PainelParceiro from "@/pages/PainelParceiro";
import ValidaCertificado from "@/pages/ValidaCertificado";
import Rede from "@/pages/Rede";
import QRScan from "@/pages/QRScan";
import { ThemeProvider } from "@/lib/ThemeContext";

function EventRedirect() {
  const { eventId } = useParams();
  const location = useLocation();
  return <Navigate to={`/event/${eventId}${location.search}`} replace />;
}

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-display font-bold text-lg">ES</span>
          </div>
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  if (authError) {
    if (authError.type === "user_not_registered") {
      return <UserNotRegisteredError />;
    } else if (authError.type === "auth_required") {
      navigateToLogin();
      return null;
    }
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace />} />}>
        <Route element={<AdminLayout />}>
          {/* Routes for all authenticated users */}
          <Route path="/" element={<AdminHome />} />
          <Route path="/profile" element={<UserProfile />} />
          <Route path="/profile/edit" element={<UserProfileEdit />} />
          <Route path="/my-events" element={<MeusEventos />} />
          <Route path="/network" element={<Rede />} />
          <Route path="/qr-scan" element={<QRScan />} />
          <Route path="/event/:eventId" element={<EventoParticipante />} />
          <Route path="/speaker-dashboard" element={<PainelPalestrante />} />
          <Route path="/partner-dashboard" element={<PainelParceiro />} />

          {/* Admin-only routes */}
          <Route element={<AdminRoute />}>
            <Route path="/business" element={<BusinessDashboard />} />
            <Route path="/events" element={<EventsList />} />
            <Route path="/events/new" element={<EventCreate />} />
            <Route path="/events/:eventId" element={<EventDetail />} />
            <Route path="/events/:eventId/edit" element={<EventEdit />} />
            <Route path="/audit" element={<AuditLog />} />
            <Route path="/notifications" element={<AdminNotifications />} />
            <Route path="/notifications/metrics" element={<NotificationMetrics />} />
            <Route path="/events/:eventId/notifications/metrics" element={<NotificationMetrics />} />
            <Route path="/people" element={<AdminPeoplePlaceholder />} />
          </Route>
          {/* Partner management — admin + partner_manager (in-page guard) */}
          <Route path="/partner" element={<AdminPartners />} />

          {/* Legacy URL redirects */}
          <Route path="/meus-eventos" element={<Navigate to="/my-events" replace />} />
          <Route path="/rede" element={<Navigate to="/network" replace />} />
          <Route path="/evento/:eventId" element={<EventRedirect />} />
          <Route path="/painel-palestrante" element={<Navigate to="/speaker-dashboard" replace />} />
          <Route path="/painel-parceiro" element={<Navigate to="/partner-dashboard" replace />} />
          <Route path="/admin/people" element={<Navigate to="/people" replace />} />
          <Route path="/admin/partners" element={<Navigate to="/partner" replace />} />
        </Route>
      </Route>
      <Route path="/validate-certificate" element={<ValidaCertificado />} />
      <Route path="/valida-certificado" element={<Navigate to="/validate-certificate" replace />} />
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClientInstance}>
          <Router>
            <AuthenticatedApp />
          </Router>
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}

export default App;
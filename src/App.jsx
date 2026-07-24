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

import { lazy, Suspense } from "react";
import { ThemeProvider } from "@/lib/ThemeContext";

// Pages — lazy loaded for smaller initial bundle
const AdminHome = lazy(() => import("@/pages/AdminHome"));
const BusinessDashboard = lazy(() => import("@/pages/BusinessDashboard"));
const EventsList = lazy(() => import("@/pages/EventsList"));
const EventCreate = lazy(() => import("@/pages/EventCreate"));
const EventEdit = lazy(() => import("@/pages/EventEdit"));
const EventDetail = lazy(() => import("@/pages/EventDetail"));
const EventModulesHome = lazy(() => import("@/pages/EventModulesHome"));
const EventModulePage = lazy(() => import("@/pages/EventModulePage"));
const AuditLog = lazy(() => import("@/pages/AuditLog"));
const AdminNotifications = lazy(() => import("@/pages/AdminNotifications"));
const NotificationMetrics = lazy(() => import("@/pages/NotificationMetrics"));
const AdminPeoplePlaceholder = lazy(() => import("@/pages/AdminPeoplePlaceholder"));
const AdminPartners = lazy(() => import("@/pages/AdminPartners"));
const UserProfile = lazy(() => import("@/pages/UserProfile"));
const UserProfileEdit = lazy(() => import("@/pages/UserProfileEdit"));
const MeusEventos = lazy(() => import("@/pages/MeusEventos"));
const EventoParticipante = lazy(() => import("@/pages/EventoParticipante"));
const PainelPalestrante = lazy(() => import("@/pages/PainelPalestrante"));
const PainelParceiro = lazy(() => import("@/pages/PainelParceiro"));
const ValidaCertificado = lazy(() => import("@/pages/ValidaCertificado"));
const Rede = lazy(() => import("@/pages/Rede"));
const QRScan = lazy(() => import("@/pages/QRScan"));

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
          <img
            src="https://media.base44.com/images/public/6a2c618daec1758ff2122225/93082474a_logoevolvesummittransparente.png"
            alt="Logo"
            className="w-10 h-10 object-contain"
          />
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
    <Suspense fallback={<div className="flex justify-center py-24"><div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>}>
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
            <Route path="/events/:eventId" element={<EventDetail />}>
              <Route index element={<EventModulesHome />} />
              <Route path="people" element={<EventModulePage module="people" />} />
              <Route path="tracks" element={<EventModulePage module="tracks" />} />
              <Route path="rooms" element={<EventModulePage module="rooms" />} />
              <Route path="sessions" element={<EventModulePage module="sessions" />} />
              <Route path="ranking" element={<EventModulePage module="ranking" />} />
              <Route path="partners" element={<EventModulePage module="partners" />} />
              <Route path="store" element={<EventModulePage module="store" />} />
              <Route path="score" element={<EventModulePage module="score" />} />
              <Route path="badges" element={<EventModulePage module="badges" />} />
              <Route path="notifications" element={<EventModulePage module="notifications" />} />
              <Route path="feedback" element={<EventModulePage module="feedback" />} />
              <Route path="raffle" element={<EventModulePage module="raffle" />} />
              <Route path="certificates" element={<EventModulePage module="certificates" />} />
            </Route>
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
    </Suspense>
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
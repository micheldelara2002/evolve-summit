/**
 * Protege rotas que somente admins podem acessar.
 * Não-admin é redirecionado para a home.
 */
import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/lib/AuthContext";
import { isAdmin } from "@/lib/access";

export default function AdminRoute() {
  const { user } = useAuth();
  if (!isAdmin(user)) return <Navigate to="/" replace />;
  return <Outlet />;
}
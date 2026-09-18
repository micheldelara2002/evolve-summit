import { base44 } from "@/api/base44Client";

// Frontend API wrapper para managePayouts (Stripe Connect — recebimento direto
// do organizador, comissão da plataforma, reserva para estornos).

async function invoke(action, payload = {}) {
  const res = await base44.functions.invoke("managePayouts", { action, ...payload });
  if (res?.data?.error) throw new Error(res.data.error);
  return res.data;
}

// ===== Organizador (gerente do evento) =====
export const getEventPayout = (eventId) => invoke("getEventPayout", { eventId });

// Cria/retoma o onboarding no Stripe e devolve a URL do fluxo (Account Link).
// Para conta já existente, os dados da empresa são opcionais (gera link novo).
export const startPayoutOnboarding = (eventId, data = {}) =>
  invoke("startOnboarding", { eventId, ...data });

export const refreshPayoutStatus = (eventId) => invoke("refreshStatus", { eventId });

// Reserva de saldo mínimo (BRL) retida pelo Stripe na conta do organizador.
export const setPayoutReserve = (eventId, amount) => invoke("setReserve", { eventId, amount });

// ===== Admin =====
export const getAdminPayoutConfig = (eventId) => invoke("getAdminConfig", { eventId });

export const setPlatformCommission = (percent) => invoke("setPlatformCommission", { percent });

// commission_percent: number (0-100) ou null para herdar o padrão da plataforma.
export const setEventCommission = (eventId, commission_percent) =>
  invoke("setEventCommission", { eventId, commission_percent });

// payout_account_id: ID da PayoutAccount ou null para desvincular (vendas voltam à conta da plataforma).
export const linkEventPayoutAccount = (eventId, payout_account_id) =>
  invoke("linkAccount", { eventId, payout_account_id: payout_account_id || null });
/**
 * Serviço de Rede — conexões estilo LinkedIn + chat 1:1 no contexto do evento.
 *
 * P0 (2026-09-29) — Notificações 'sininho' migradas para o backend: o
 * manageConnection cria campanha/recipient na própria transação da conexão,
 * server-side (o RLS de NotificationRecipient.create é admin-only — a criação
 * direta do frontend falhava silenciosamente para não-admins, e a resolução do
 * destinatário varria User.list() do cliente). Best-effort: falha na notificação
 * NÃO desfaz a conexão.
 */
import { base44 } from "@/api/base44Client";

/**
 * Envia pedido de conexão.
 * Regras (server-side): não para si, não duplica, auto-aceita se há pedido
 * reverso pendente. Notificações criadas pelo próprio backend.
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
export async function sendConnectionRequest({ eventId, requesterPerson, receiverPerson, requesterParticipantId }) {
  const response = await base44.functions.invoke('manageConnection', {
    action: "send",
    eventId,
    requesterPersonId: requesterPerson.id,
    requesterName: requesterPerson.full_name,
    receiverPersonId: receiverPerson.id,
    receiverName: receiverPerson.full_name,
    requesterParticipantId,
  });
  return response.data;
}

export async function acceptConnectionRequest({ request, eventId, accepterPerson, accepterParticipantId }) {
  const response = await base44.functions.invoke('manageConnection', {
    action: "accept",
    requestId: request.id,
    eventId,
    accepterPersonId: accepterPerson.id,
    accepterName: accepterPerson.full_name,
    accepterParticipantId,
  });
  return response.data;
}

export async function refuseConnectionRequest({ requestId, myPersonId: _myPersonId = null }) {
  const response = await base44.functions.invoke('manageConnection', {
    action: "refuse",
    requestId,
  });
  const result = response.data;
  if (!result.ok) {
    if (result.reason === "unauthorized") throw new Error("Você não tem permissão para recusar este pedido.");
    if (result.reason === "not_found") throw new Error("Pedido não encontrado.");
    if (result.reason === "not_pending") throw new Error("Este pedido não está mais pendente.");
    throw new Error("Erro ao recusar pedido.");
  }
  return { ok: true };
}

export async function cancelConnectionRequest({ requestId, myPersonId: _myPersonId = null }) {
  const response = await base44.functions.invoke('manageConnection', {
    action: "cancel",
    requestId,
  });
  const result = response.data;
  if (!result.ok) {
    if (result.reason === "unauthorized") throw new Error("Você não tem permissão para cancelar este pedido.");
    if (result.reason === "not_found") throw new Error("Pedido não encontrado.");
    if (result.reason === "not_pending") throw new Error("Este pedido não está mais pendente.");
    throw new Error("Erro ao cancelar pedido.");
  }
  return { ok: true };
}

/** Busca ou cria thread de chat 1:1 para um par de pessoas no evento. */
export async function getOrCreateThread({ eventId, myPersonId, myPersonName, otherPersonId, otherPersonName }) {
  const response = await base44.functions.invoke('getOrCreateThread', {
    eventId, myPersonId, myPersonName, otherPersonId, otherPersonName,
  });
  return response.data;
}

/** Envia mensagem via backend — verifica posse da thread, sanitiza, atualiza preview e notifica. */
export async function sendMessage({ threadId, eventId, senderPersonId, senderName, messageText }) {
  const response = await base44.functions.invoke('sendChatMessage', {
    threadId,
    eventId,
    senderPersonId,
    senderName,
    messageText,
  });
  return response.data?.message;
}
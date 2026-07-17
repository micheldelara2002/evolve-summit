/**
 * Serviço de Rede — conexões estilo LinkedIn + chat 1:1 no contexto do evento.
 * Integra notificações (sininho) e motor de pontuação (conexao_aceita).
 */
import { base44 } from "@/api/base44Client";
import { sanitizeText } from "@/utils/sanitize";

/** Ordena dois IDs para garantir unicidade do par. */
export function sortPersonIds(a, b) {
  return a < b ? [a, b] : [b, a];
}

/** Busca user_id pelo email da Person (para entregar notificação no sininho). */
async function findUserIdByEmail(email) {
  if (!email) return null;
  try {
    const users = await base44.entities.User.list();
    const u = users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    return u?.id || null;
  } catch {
    return null;
  }
}

/** Busca Person por ID (para notificar o requester ao aceitar). */
async function getPersonById(personId) {
  try {
    const persons = await base44.entities.Person.filter({ id: personId, is_active: true });
    return persons?.[0] || null;
  } catch {
    return null;
  }
}

/** Cria NotificationCampaign + NotificationRecipient para um único destinatário (sininho). */
async function sendDirectNotification({ eventId, recipientPerson, title, message, ctaLabel, ctaTarget }) {
  if (!recipientPerson?.contact_email) return;
  const userId = await findUserIdByEmail(recipientPerson.contact_email);
  if (!userId) return;
  try {
    const campaign = await base44.entities.NotificationCampaign.create({
      scope_type: "event",
      scope_event_id: eventId,
      title,
      message,
      type: "informativa",
      audience_type: "manual",
      priority: "normal",
      status: "sent",
      sent_at: new Date().toISOString(),
      recipients_count: 1,
      delivered_count: 1,
      cta_label: ctaLabel || undefined,
      cta_target: ctaTarget || undefined,
    });
    await base44.entities.NotificationRecipient.create({
      campaign_id: campaign.id,
      recipient_user_id: userId,
      recipient_name: recipientPerson.full_name,
      delivery_status: "sent",
      delivered_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("rede notification failed:", e);
  }
}

/**
 * Envia pedido de conexão.
 * Regras: não para si, não duplica, auto-aceita se há pedido reverso pendente.
 * @returns {{ ok: boolean, reason: string }}
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
  const result = response.data;

  if (result.ok) {
    const safeReqName = sanitizeText(requesterPerson.full_name);
    if (result.reason === "request_sent") {
      await sendDirectNotification({
        eventId,
        recipientPerson: receiverPerson,
        title: "Novo pedido de conexão",
        message: `${safeReqName} quer se conectar com você.`,
        ctaLabel: "Ver pedidos",
        ctaTarget: `/evento/${eventId}`,
      });
    } else if (result.reason === "auto_accepted") {
      await sendDirectNotification({
        eventId,
        recipientPerson: receiverPerson,
        title: "Conexão aceita!",
        message: `${safeReqName} aceitou seu pedido de conexão.`,
        ctaLabel: "Iniciar conversa",
        ctaTarget: `/evento/${eventId}`,
      });
    }
  }

  return result;
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
  const result = response.data;

  if (result.ok && result.reason === "accepted") {
    const safeAccepterName = sanitizeText(accepterPerson.full_name);
    const requesterPerson = await getPersonById(request.requester_person_id);
    if (requesterPerson) {
      await sendDirectNotification({
        eventId,
        recipientPerson: requesterPerson,
        title: "Conexão aceita!",
        message: `${safeAccepterName} aceitou seu pedido de conexão.`,
        ctaLabel: "Iniciar conversa",
        ctaTarget: `/evento/${eventId}`,
      });
    }
  }

  return result;
}

export async function refuseConnectionRequest({ requestId }) {
  await base44.entities.ConnectionRequest.update(requestId, { status: "refused" });
  return { ok: true };
}

export async function cancelConnectionRequest({ requestId }) {
  await base44.entities.ConnectionRequest.update(requestId, { status: "canceled" });
  return { ok: true };
}

/** Busca ou cria thread de chat 1:1 para um par de pessoas no evento. */
export async function getOrCreateThread({ eventId, myPersonId, myPersonName, otherPersonId, otherPersonName }) {
  const response = await base44.functions.invoke('getOrCreateThread', {
    eventId, myPersonId, myPersonName, otherPersonId, otherPersonName,
  });
  return response.data;
}

/** Envia mensagem, atualiza preview da thread e notifica o destinatário (não o remetente). */
export async function sendMessage({ threadId, eventId, senderPersonId, senderName, messageText }) {
  const safeText = sanitizeText(messageText);
  const safeSenderName = sanitizeText(senderName);
  const msg = await base44.entities.ChatMessage.create({
    thread_id: threadId,
    event_id: eventId,
    sender_person_id: senderPersonId,
    sender_name: safeSenderName,
    message_text: safeText,
  });
  await base44.entities.ChatThread.update(threadId, {
    last_message_at: new Date().toISOString(),
    last_message_preview: safeText.substring(0, 100),
  });

  // Notificar o destinatário (o outro lado da thread), nunca o remetente
  try {
    const threads = await base44.entities.ChatThread.filter({ id: threadId, is_deleted: false });
    const thread = threads?.[0];
    if (thread) {
      const otherPersonId = thread.person_a_id === senderPersonId ? thread.person_b_id : thread.person_a_id;
      if (otherPersonId && otherPersonId !== senderPersonId) {
        const otherPerson = await getPersonById(otherPersonId);
        if (otherPerson) {
          await sendDirectNotification({
            eventId,
            recipientPerson: otherPerson,
            title: `Nova mensagem de ${safeSenderName}`,
            message: safeText.substring(0, 100),
            ctaLabel: "Ver conversa",
            ctaTarget: `/evento/${eventId}`,
          });
        }
      }
    }
  } catch (e) {
    console.error("chat notification failed:", e);
  }

  return msg;
}
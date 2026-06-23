/**
 * Serviço de Rede — conexões estilo LinkedIn + chat 1:1 no contexto do evento.
 * Integra notificações (sininho) e motor de pontuação (conexao_aceita).
 */
import { base44 } from "@/api/base44Client";
import { processAction } from "@/lib/scoringEngine";

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
  // 1. Já conectados?
  const [aId, bId] = sortPersonIds(requesterPerson.id, receiverPerson.id);
  const existingConn = await base44.entities.Connection.filter({
    event_id: eventId, person_a_id: aId, person_b_id: bId, is_deleted: false,
  });
  if (existingConn?.length > 0) return { ok: false, reason: "already_connected" };

  // 2. Pedido existente em qualquer direção?
  const allReqs = await base44.entities.ConnectionRequest.filter({ event_id: eventId, is_deleted: false });
  const pending = allReqs.find(
    (r) =>
      r.status === "pending" &&
      ((r.requester_person_id === requesterPerson.id && r.receiver_person_id === receiverPerson.id) ||
        (r.requester_person_id === receiverPerson.id && r.receiver_person_id === requesterPerson.id))
  );
  if (pending) {
    // Se o outro lado me enviou um pedido, auto-aceitar
    if (pending.requester_person_id === receiverPerson.id) {
      await acceptConnectionRequestInternal({ request: pending, eventId, accepterPerson: requesterPerson, accepterParticipantId: requesterParticipantId });
      return { ok: true, reason: "auto_accepted" };
    }
    return { ok: false, reason: "already_pending" };
  }

  // 3. Criar pedido
  await base44.entities.ConnectionRequest.create({
    event_id: eventId,
    requester_person_id: requesterPerson.id,
    requester_name: requesterPerson.full_name,
    receiver_person_id: receiverPerson.id,
    receiver_name: receiverPerson.full_name,
    status: "pending",
  });

  // 4. Notificar destinatário
  await sendDirectNotification({
    eventId,
    recipientPerson: receiverPerson,
    title: "Novo pedido de conexão",
    message: `${requesterPerson.full_name} quer se conectar com você.`,
    ctaLabel: "Ver pedidos",
    ctaTarget: `/evento/${eventId}`,
  });

  return { ok: true, reason: "request_sent" };
}

/** Lógica interna de aceite — usada por acceptConnectionRequest e auto-accept. */
async function acceptConnectionRequestInternal({ request, eventId, accepterPerson, accepterParticipantId }) {
  // Atualizar pedido
  await base44.entities.ConnectionRequest.update(request.id, { status: "accepted" });

  // Criar conexão (IDs ordenados)
  const [aId, bId] = sortPersonIds(request.requester_person_id, accepterPerson.id);
  await base44.entities.Connection.create({
    event_id: eventId,
    person_a_id: aId,
    person_b_id: bId,
    person_a_name: aId === request.requester_person_id ? request.requester_name : accepterPerson.full_name,
    person_b_name: bId === request.requester_person_id ? request.requester_name : accepterPerson.full_name,
  });

  // Disparar pontuação para ambos (dedup por par+evento no scoringEngine)
  const requesterParts = await base44.entities.Participant.filter({
    event_id: eventId, person_id: request.requester_person_id, is_deleted: false,
  });
  const requesterParticipantId = requesterParts?.[0]?.id;
  if (accepterParticipantId && requesterParticipantId) {
    await processAction({ eventId, participantId: accepterParticipantId, acao: "conexao_aceita", refId: requesterParticipantId });
    await processAction({ eventId, participantId: requesterParticipantId, acao: "conexao_aceita", refId: accepterParticipantId });
  }

  // Notificar quem enviou o pedido
  const requesterPerson = await getPersonById(request.requester_person_id);
  if (requesterPerson) {
    await sendDirectNotification({
      eventId,
      recipientPerson: requesterPerson,
      title: "Conexão aceita!",
      message: `${accepterPerson.full_name} aceitou seu pedido de conexão.`,
      ctaLabel: "Iniciar conversa",
      ctaTarget: `/evento/${eventId}`,
    });
  }
}

export async function acceptConnectionRequest({ request, eventId, accepterPerson, accepterParticipantId }) {
  await acceptConnectionRequestInternal({ request, eventId, accepterPerson, accepterParticipantId });
  return { ok: true };
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
  const [aId, bId] = sortPersonIds(myPersonId, otherPersonId);
  const existing = await base44.entities.ChatThread.filter({
    event_id: eventId, person_a_id: aId, person_b_id: bId, is_deleted: false,
  });
  if (existing?.length > 0) return existing[0];
  return await base44.entities.ChatThread.create({
    event_id: eventId,
    person_a_id: aId,
    person_b_id: bId,
    person_a_name: aId === myPersonId ? myPersonName : otherPersonName,
    person_b_name: bId === myPersonId ? myPersonName : otherPersonName,
  });
}

/** Envia mensagem e atualiza preview da thread. */
export async function sendMessage({ threadId, eventId, senderPersonId, senderName, messageText }) {
  const msg = await base44.entities.ChatMessage.create({
    thread_id: threadId,
    event_id: eventId,
    sender_person_id: senderPersonId,
    sender_name: senderName,
    message_text: messageText,
  });
  await base44.entities.ChatThread.update(threadId, {
    last_message_at: new Date().toISOString(),
    last_message_preview: messageText.substring(0, 100),
  });
  return msg;
}
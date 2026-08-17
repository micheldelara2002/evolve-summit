import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { threadId, eventId, senderPersonId, senderName, messageText } = await req.json();
    if (!threadId || !senderPersonId || !messageText?.trim()) {
      return Response.json({ error: 'Parâmetros obrigatórios ausentes.' }, { status: 400 });
    }

    // Verify thread ownership: sender must be a participant AND match the authenticated user's Person
    const userPersons = await base44.asServiceRole.entities.Person.filter({ contact_email: user.email });
    const userPersonId = userPersons[0]?.id;

    const threads = await base44.asServiceRole.entities.ChatThread.filter({ id: threadId, is_deleted: false });
    const thread = threads?.[0];
    if (!thread) return Response.json({ error: 'Thread não encontrada.' }, { status: 404 });

    if (eventId && eventId !== thread.event_id) {
      return Response.json({ error: 'Evento da mensagem não corresponde ao evento da conversa.' }, { status: 403 });
    }
    const effectiveEventId = thread.event_id;

    const threadParticipants = await base44.asServiceRole.entities.Participant.filter({
      event_id: effectiveEventId,
      is_deleted: false,
      person_id: { $in: [thread.person_a_id, thread.person_b_id] },
      registration_status: { $ne: 'cancelled' },
    });
    const eventPersonIds = new Set(threadParticipants.map((p) => p.person_id).filter(Boolean));
    if (!eventPersonIds.has(thread.person_a_id) || !eventPersonIds.has(thread.person_b_id)) {
      return Response.json({ error: 'Conversa inválida para este evento.' }, { status: 403 });
    }

    const isParticipant = thread.person_a_id === senderPersonId || thread.person_b_id === senderPersonId;
    const isOwner = senderPersonId === userPersonId || user.role === 'admin';
    if (!isParticipant || !isOwner) {
      return Response.json({ error: 'Sem permissão para enviar mensagens nesta conversa.' }, { status: 403 });
    }

    const safeText = sanitizeText(messageText);
    const safeSenderName = sanitizeText(senderName);
    if (!safeText) {
      return Response.json({ error: 'Mensagem vazia após sanitização.' }, { status: 400 });
    }

    // Create message
    const msg = await base44.asServiceRole.entities.ChatMessage.create({
      thread_id: threadId,
      event_id: effectiveEventId,
      sender_person_id: senderPersonId,
      sender_name: safeSenderName,
      message_text: safeText,
    });

    // Update thread preview
    await base44.asServiceRole.entities.ChatThread.update(threadId, {
      last_message_at: new Date().toISOString(),
      last_message_preview: safeText.substring(0, 100),
    });

    // Notify the other participant (best-effort, não bloqueia o envio)
    try {
      const otherPersonId = thread.person_a_id === senderPersonId ? thread.person_b_id : thread.person_a_id;
      if (otherPersonId && otherPersonId !== senderPersonId) {
        const otherPersons = await base44.asServiceRole.entities.Person.filter({ id: otherPersonId, is_active: true });
        const otherPerson = otherPersons?.[0];
        if (otherPerson?.contact_email) {
          const users = await base44.asServiceRole.entities.User.list();
          const recipient = users.find((u) => u.email?.toLowerCase() === otherPerson.contact_email.toLowerCase());
          if (recipient) {
            const campaign = await base44.asServiceRole.entities.NotificationCampaign.create({
              scope_type: "event",
              scope_event_id: effectiveEventId,
              title: `Nova mensagem de ${safeSenderName}`,
              message: safeText.substring(0, 100),
              type: "informativa",
              audience_type: "manual",
              priority: "normal",
              status: "sent",
              sent_at: new Date().toISOString(),
              recipients_count: 1,
              delivered_count: 1,
              cta_label: "Ver conversa",
              cta_target: `/event/${effectiveEventId}`,
            });
            await base44.asServiceRole.entities.NotificationRecipient.create({
              campaign_id: campaign.id,
              recipient_user_id: recipient.id,
              recipient_name: otherPerson.full_name,
              delivery_status: "sent",
              delivered_at: new Date().toISOString(),
            });
          }
        }
      }
    } catch (e) {
      console.error('chat notification failed:', e);
    }

    return Response.json({ ok: true, message: msg });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
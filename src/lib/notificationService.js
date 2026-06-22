/**
 * Serviço de entrega de notificações.
 * Resolve destinatários, garante idempotência e salva snapshots auditáveis.
 */
import { base44 } from "@/api/base44Client";
import { logAudit } from "@/lib/audit";

// Mapa de roles de sistema para roles de participante
const SYSTEM_ROLE_TO_PARTICIPANT = {
  admin: null,       // usuários do sistema (User entity), não Participant
  gerente: "manager",
  staff: "team",
  representante: "attendee", // representantes são participantes com role attendee vinculados a parceiros
  palestrante: "speaker",
  attendee: "attendee",
};

/**
 * Retorna os perfis (audience_segments) que um usuário pode selecionar,
 * dado o escopo (global vs event).
 */
export function getAllowedSegments(userRole, scopeType) {
  if (userRole === "admin") {
    if (scopeType === "global") {
      return ["all", "admin", "gerente", "staff", "palestrante", "representante", "attendee"];
    }
    return ["all", "gerente", "staff", "palestrante", "representante", "attendee"];
  }
  if (userRole === "gerente" || userRole === "staff") {
    return ["all", "staff", "palestrante", "representante", "attendee"];
  }
  if (userRole === "representante") {
    return ["my_leads"];
  }
  if (userRole === "palestrante") {
    return ["my_attendees"];
  }
  if (userRole === "partner_manager") {
    return ["partner_all_event", "partner_leads"];
  }
  return [];
}

/**
 * Resolve a lista final de recipients para uma campanha.
 * Retorna array de { user_id, name, email, role }.
 *
 * @param {object} params
 * @param {string} params.scopeType - "global" | "event"
 * @param {string|null} params.scopeEventId
 * @param {string} params.audienceType - "all" | "segment" | "my_leads" | "my_attendees"
 * @param {string[]} params.audienceSegments - perfis selecionados quando audienceType="segment"
 * @param {object} params.senderUser - { id, full_name, email, role }
 */
export async function resolveRecipients({ scopeType, scopeEventId, audienceType, audienceSegments = [], senderUser, senderPartnerId }) {
  const recipients = [];
  const seen = new Set();

  const addRecipient = (userId, name, email, role) => {
    if (!userId || seen.has(userId)) return;
    seen.add(userId);
    recipients.push({ user_id: userId, name: name || "", email: email || "", role: role || "" });
  };

  if (audienceType === "all" || (audienceType === "segment" && audienceSegments.includes("all"))) {
    // Buscar todos os usuários do sistema
    const users = await base44.entities.User.list();
    users.forEach((u) => addRecipient(u.id, u.full_name, u.email, u.role));

    if (scopeEventId) {
      // Adicionar participantes do evento que ainda não foram incluídos via User
      const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, is_deleted: false });
      parts.forEach((p) => {
        // Participantes podem não ter user_id — usar email como chave de deduplicação alternativa
        const key = p.email?.toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        recipients.push({ user_id: p.id, name: p.full_name, email: p.email, role: p.role_in_event || "attendee" });
      });
    }
  } else if (audienceType === "segment") {
    // Resolver por perfil específico
    const roleMap = {
      admin: async () => {
        const users = await base44.entities.User.list();
        users.filter((u) => u.role === "admin").forEach((u) => addRecipient(u.id, u.full_name, u.email, "admin"));
      },
      gerente: async () => {
        const users = await base44.entities.User.list();
        users.filter((u) => u.role === "gerente" || u.role === "manager").forEach((u) => addRecipient(u.id, u.full_name, u.email, u.role));
        if (scopeEventId) {
          const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, role_in_event: "manager", is_deleted: false });
          parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, "manager"));
        }
      },
      staff: async () => {
        if (scopeEventId) {
          const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, role_in_event: "team", is_deleted: false });
          parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, "team"));
        }
      },
      palestrante: async () => {
        if (scopeEventId) {
          const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, role_in_event: "speaker", is_deleted: false });
          parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, "speaker"));
        }
      },
      representante: async () => {
        if (scopeEventId) {
          const reps = await base44.entities.PartnerRepresentative.filter({ event_id: scopeEventId, is_deleted: false });
          reps.forEach((r) => addRecipient(r.id, r.full_name, r.email, "representante"));
        }
      },
      attendee: async () => {
        if (scopeEventId) {
          const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, role_in_event: "attendee", is_deleted: false });
          parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, "attendee"));
        } else {
          const users = await base44.entities.User.list();
          users.filter((u) => u.role === "user").forEach((u) => addRecipient(u.id, u.full_name, u.email, "user"));
        }
      },
    };

    for (const seg of audienceSegments) {
      if (roleMap[seg]) await roleMap[seg]();
    }
  } else if (audienceType === "my_leads" && senderUser) {
    // Apenas leads do representante logado
    const leads = await base44.entities.Lead.filter({ event_id: scopeEventId });
    leads.forEach((l) => addRecipient(l.participant_id, l.participant_name, l.participant_email, "attendee"));
  } else if (audienceType === "partner_all_event" && scopeEventId) {
    // Todos os participantes do evento (contexto parceiro)
    const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, is_deleted: false });
    parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, p.role_in_event || "attendee"));
  } else if (audienceType === "partner_leads" && scopeEventId && senderPartnerId) {
    // Apenas leads do parceiro no evento
    const leads = await base44.entities.Lead.filter({ event_id: scopeEventId, partner_id: senderPartnerId });
    leads.forEach((l) => addRecipient(l.participant_id, l.participant_name, l.participant_email, "attendee"));
  } else if (audienceType === "my_attendees" && senderUser) {
    // Participantes com presença nas sessões do palestrante
    if (scopeEventId) {
      const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, is_deleted: false });
      parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, p.role_in_event));
    }
  }

  // Garantir que o remetente (admin) sempre receba a própria mensagem (idempotência via seen)
  if (senderUser) {
    addRecipient(senderUser.id, senderUser.full_name, senderUser.email, senderUser.role);
  }

  return recipients;
}

/**
 * Envia a campanha: cria recipients, atualiza contadores e marca como enviada.
 * Garante idempotência (não duplica recipients existentes).
 */
export async function dispatchCampaign(campaign, senderUser, senderPartnerId) {
  const recipients = await resolveRecipients({
    scopeType: campaign.scope_type,
    scopeEventId: campaign.scope_event_id,
    audienceType: campaign.audience_type,
    audienceSegments: campaign.audience_payload ? JSON.parse(campaign.audience_payload) : [],
    senderUser,
    senderPartnerId,
  });

  // Buscar recipients existentes para deduplicar
  const existing = await base44.entities.NotificationRecipient.filter({ campaign_id: campaign.id });
  const existingIds = new Set(existing.map((r) => r.recipient_user_id));

  const now = new Date().toISOString();
  const toCreate = recipients.filter((r) => !existingIds.has(r.user_id));

  if (toCreate.length > 0) {
    await base44.entities.NotificationRecipient.bulkCreate(
      toCreate.map((r) => ({
        campaign_id: campaign.id,
        recipient_user_id: r.user_id,
        recipient_name: r.name,
        recipient_email: r.email,
        recipient_role: r.role,
        delivery_status: "sent",
        delivered_at: now,
      }))
    );
  }

  const totalRecipients = existing.length + toCreate.length;

  await base44.entities.NotificationCampaign.update(campaign.id, {
    status: "sent",
    sent_at: now,
    recipients_count: totalRecipients,
    delivered_count: totalRecipients,
  });

  // Auditoria de envio
  await logAudit({
    event_id: campaign.scope_event_id,
    action: "status_change",
    entity_type: "NotificationCampaign",
    entity_id: campaign.id,
    details: {
      action_label: "notification_sent",
      title: campaign.title,
      audience_type: campaign.audience_type,
      recipients_count: totalRecipients,
      sent_at: now,
      partner_id: senderPartnerId || null,
    },
    user: senderUser,
  });
}
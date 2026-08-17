/**
 * Serviço de entrega de notificações.
 * Resolve destinatários, garante idempotência e salva snapshots auditáveis.
 */
import { base44 } from "@/api/base44Client";
import { logAudit } from "@/lib/audit";
import { isAdmin, isPartnerManager } from "@/lib/access";

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
/**
 * Retorna os perfis (audience_segments) que um usuário pode selecionar.
 * User.role só é admin|user. Papel de parceiro vem de PartnerRepresentative
 * (via isPartnerManager/user.partner_reps); papéis de evento (gerente/staff/
 * palestrante/representante) são resolvidos via Participant.role_in_event /
 * EventMembership.role no dispatch, não aqui.
 */
export function getAllowedSegments(user, scopeType) {
  if (isAdmin(user)) {
    if (scopeType === "global") {
      return ["all", "admin", "gerente", "staff", "palestrante", "representante", "attendee"];
    }
    return ["all", "gerente", "staff", "palestrante", "representante", "attendee"];
  }
  if (isPartnerManager(user)) {
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

  // Fetch system users once — reused across segments
  let _allUsers = null;
  const getAllUsers = async () => {
    if (!_allUsers) _allUsers = await base44.entities.User.list();
    return _allUsers;
  };

  if (audienceType === "all" || (audienceType === "segment" && audienceSegments.includes("all"))) {
    // Buscar todos os usuários do sistema
    const users = await getAllUsers();
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
        const users = await getAllUsers();
        users.filter((u) => u.role === "admin").forEach((u) => addRecipient(u.id, u.full_name, u.email, "admin"));
      },
      gerente: async () => {
        // Gerentes do evento são resolvidos via Participant.role_in_event
        // (User.role nunca é "gerente"/"manager").
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
          const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, role_in_event: "partner_rep", is_deleted: false });
          parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, "representante"));
        }
      },
      attendee: async () => {
        if (scopeEventId) {
          const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, role_in_event: "attendee", is_deleted: false });
          parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, "attendee"));
        } else {
          const users = await getAllUsers();
          users.filter((u) => u.role === "user").forEach((u) => addRecipient(u.id, u.full_name, u.email, "user"));
        }
      },
    };

    for (const seg of audienceSegments) {
      if (roleMap[seg]) await roleMap[seg]();
    }
  } else if (audienceType === "my_leads" && senderUser) {
    // Apenas leads do parceiro do representante logado — fail-safe se sem partner_id
    if (senderPartnerId) {
      const leads = await base44.entities.Lead.filter({ event_id: scopeEventId, partner_id: senderPartnerId });
      leads.forEach((l) => addRecipient(l.participant_id, l.participant_name, l.participant_email, "attendee"));
    }
  } else if (audienceType === "partner_all_event" && scopeEventId) {
    // Todos os participantes do evento (contexto parceiro)
    const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, is_deleted: false });
    parts.forEach((p) => addRecipient(p.id, p.full_name, p.email, p.role_in_event || "attendee"));
  } else if (audienceType === "partner_leads" && scopeEventId && senderPartnerId) {
    // Apenas leads do parceiro no evento
    const leads = await base44.entities.Lead.filter({ event_id: scopeEventId, partner_id: senderPartnerId });
    leads.forEach((l) => addRecipient(l.participant_id, l.participant_name, l.participant_email, "attendee"));
  } else if (audienceType === "my_attendees" && senderUser) {
    // Participantes com presença comprovada nas sessões do palestrante
    if (scopeEventId) {
      // 1. Encontrar a Person do palestrante pelo email
      const persons = await base44.entities.Person.filter({ contact_email: senderUser.email, is_active: true });
      const speakerPerson = persons?.[0];
      if (speakerPerson) {
        // 2. Encontrar o Participant do palestrante no evento
        const speakerParts = await base44.entities.Participant.filter({ event_id: scopeEventId, person_id: speakerPerson.id, is_deleted: false });
        const speakerPartIds = speakerParts.map((p) => p.id);
        if (speakerPartIds.length > 0) {
          // 3. Encontrar as sessões do palestrante
          const allSessions = await base44.entities.Session.filter({ event_id: scopeEventId, is_deleted: false });
          const speakerSessionIds = allSessions
            .filter((s) => speakerPartIds.includes(s.speaker_id))
            .map((s) => s.id);
          if (speakerSessionIds.length > 0) {
            // 4. Encontrar presenças nas sessões do palestrante
            const attendance = await base44.entities.SessionAttendance.filter({ event_id: scopeEventId, is_present: true });
            const attendedParticipantIds = new Set(
              attendance
                .filter((a) => speakerSessionIds.includes(a.session_id))
                .map((a) => a.participant_id)
            );
            // 5. Resolver apenas participantes que compareceram
            const parts = await base44.entities.Participant.filter({ event_id: scopeEventId, is_deleted: false });
            parts.forEach((p) => {
              if (attendedParticipantIds.has(p.id)) {
                addRecipient(p.id, p.full_name, p.email, p.role_in_event || "attendee");
              }
            });
          }
        }
      }
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
  // Dispatch server-side — resolve recipients, deduplicate, create, and update status
  const response = await base44.functions.invoke('dispatchNotificationCampaign', {
    campaign,
    senderPartnerId,
  });
  const result = response.data;

  if (!result?.ok) {
    throw new Error(result?.error || 'Falha no envio da campanha.');
  }

  // Auditoria (best-effort, não bloqueia o envio)
  try {
    await logAudit({
      event_id: campaign.scope_event_id,
      action: "status_change",
      entity_type: "NotificationCampaign",
      entity_id: campaign.id,
      details: {
        action_label: "notification_sent",
        title: campaign.title,
        audience_type: campaign.audience_type,
        recipients_count: result.recipients_count,
        sent_at: new Date().toISOString(),
        partner_id: senderPartnerId || null,
      },
      user: senderUser,
    });
  } catch (e) {
    console.error("audit log failed:", e);
  }
}
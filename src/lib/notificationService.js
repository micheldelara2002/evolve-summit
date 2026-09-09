/**
 * Serviço de entrega de notificações.
 * Resolve destinatários, garante idempotência e salva snapshots auditáveis.
 */
import { base44 } from "@/api/base44Client";
import { logAudit } from "@/lib/audit";
import { isAdmin, isPartnerManager } from "@/lib/access";

// EventMembership.role → audience segments oferecidos àquele papel no evento.
// Espelha a autorização do backend (eventAuth EVENT_MANAGER_ROLES = manager/team).
const EVENT_ROLE_SEGMENTS = {
  manager: ["all", "gerente", "staff", "palestrante", "representante", "attendee"],
  team: ["all", "gerente", "staff", "palestrante", "representante", "attendee"],
  speaker: ["my_attendees"],
  partner_rep: ["my_leads"],
};

/**
 * Retorna os audience_segments que um usuário pode selecionar.
 *
 * User.role só é admin|user. Papéis de evento vêm de EventMembership.role
 * (resolvidos para scopeEventId); papéis de parceiro vêm de
 * PartnerRepresentative (via isPartnerManager). Escopo global não-admin
 * retorna [] (apenas admin envia campanhas globais — enforce no backend).
 * Fail-safe: sem contexto suficiente → [].
 */
export function getAllowedSegments(user, scopeType, scopeEventId, memberships = []) {
  if (isAdmin(user)) {
    if (scopeType === "global") {
      return ["all", "admin", "gerente", "staff", "palestrante", "representante", "attendee"];
    }
    return ["all", "gerente", "staff", "palestrante", "representante", "attendee"];
  }
  // Não-admin no escopo global: sem permissão (backend: apenas admin).
  if (scopeType === "global") return [];
  // Escopo de evento: requer scopeEventId + papéis contextuais nele.
  if (!scopeEventId) return [];
  const rolesInEvent = new Set(
    (memberships || [])
      .filter((m) => m.event_id === scopeEventId && m.is_active !== false && m.is_deleted !== false)
      .map((m) => m.role)
  );
  const segments = new Set();
  for (const role of rolesInEvent) {
    const segs = EVENT_ROLE_SEGMENTS[role];
    if (segs) segs.forEach((s) => segments.add(s));
  }
  // Gestor de parceiro — determinado por PartnerRepresentative (não User.role)
  if (isPartnerManager(user)) {
    segments.add("partner_all_event");
    segments.add("partner_leads");
  }
  return [...segments];
}

/**
 * Envia a campanha: cria recipients, atualiza contadores e marca como enviada.
 * (A resolução de destinatários é feita server-side em dispatchNotificationCampaign.)
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
    });
  } catch (e) {
    console.error("audit log failed:", e);
  }
}
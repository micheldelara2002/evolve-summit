import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { extractClientIp } from "../../shared/commerceAudit.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    const entityType = typeof body.entity_type === 'string' ? body.entity_type.trim() : '';
    const entityId = typeof body.entity_id === 'string' ? body.entity_id.trim() : '';

    // Audit events are intentionally generic, but the server rejects malformed or
    // oversized records so the log cannot be used as an arbitrary payload sink.
    const allowedEntityTypes = new Set([
      'Event', 'Participant', 'Session', 'Track', 'Room', 'Badge', 'ScoringRule',
      'StoreItem', 'Partner', 'EventPartner', 'PartnerRepresentative', 'NotificationCampaign',
      'Submission', 'CallForPapers', 'AwardSubmission', 'AwardEvaluation', 'Certificate',
      'CertificateTemplate', 'MentorshipRequest', 'JobPosting', 'Lead', 'Person'
    ]);
    const allowedActions = new Set(['create', 'update', 'delete', 'soft_delete', 'status_change', 'role_change', 'publish', 'unpublish', 'send', 'approve', 'reject', 'waitlist', 'cancel', 'archive', 'restore']);
    if (!action || action.length > 64 || !allowedActions.has(action)) {
      return Response.json({ error: 'Ação de auditoria inválida.' }, { status: 400 });
    }
    if (!entityType || !allowedEntityTypes.has(entityType)) {
      return Response.json({ error: 'Tipo de entidade de auditoria inválido.' }, { status: 400 });
    }
    if (entityId.length > 128) {
      return Response.json({ error: 'entity_id inválido.' }, { status: 400 });
    }

    // F3-08 (2026-11-12) — Validação de ESCRITA da trilha: entradas com event_id
    // exigem papéis de GESTÃO do evento (admin, manager ou team); sem event_id,
    // apenas admin. Antes bastava ser participante do evento para gravar
    // auditoria — um participante conseguia inserir registros de ações que não
    // executou (status_change, role_change) na trilha do evento. Quem só
    // participa não escreve auditoria; a leitura continua admin-only pela RLS.
    const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : '';
    if (eventId) {
      if (!/^[0-9a-f]{24}$/i.test(eventId)) {
        return Response.json({ error: 'event_id inválido.' }, { status: 400 });
      }
      const gate = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
      if (!gate.authorized) {
        return Response.json({ error: 'Somente a gestão do evento pode registrar auditoria.' }, { status: 403 });
      }
    } else if (user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão para registrar auditoria sem escopo de evento.' }, { status: 403 });
    }

    // Extract client IP from standard proxy headers (shared helper)
    const ip = extractClientIp(req);

    await base44.asServiceRole.entities.AuditLog.create({
      event_id: eventId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      user_id: user.id,
      user_name: user.full_name || user.email || "",
      details: (() => {
        const value = typeof body.details === "string" ? body.details : JSON.stringify(body.details || {});
        return value.length > 10000 ? value.slice(0, 10000) : value;
      })(),
      ip_address: ip,
    });

    return Response.json({ ok: true });
  } catch (error) {
    // Audit failures should not crash the calling flow — log and return error
    console.error("logAuditEvent error:", error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}
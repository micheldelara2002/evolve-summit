import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

Deno.serve(async (req) => {
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

    // Extract client IP from standard proxy headers
    const forwarded = req.headers.get("x-forwarded-for");
    const ip = (forwarded ? forwarded.split(",")[0].trim() : "")
             || req.headers.get("x-real-ip")
             || req.headers.get("cf-connecting-ip")
             || "";

    await base44.asServiceRole.entities.AuditLog.create({
      event_id: body.event_id || "",
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
});
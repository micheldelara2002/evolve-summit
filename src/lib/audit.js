import { base44 } from "@/api/base44Client";

/**
 * Logs an audit event server-side so the real client IP is captured from request headers.
 * The user is resolved from the authenticated session, not passed from the client.
 */
export async function logAudit({ event_id, action, entity_type, entity_id, details }) {
  try {
    await base44.functions.invoke('logAuditEvent', {
      event_id: event_id || "",
      action,
      entity_type,
      entity_id: entity_id || "",
      details: typeof details === "string" ? details : JSON.stringify(details || {}),
    });
  } catch (e) {
    console.error("Audit log failed:", e);
  }
}
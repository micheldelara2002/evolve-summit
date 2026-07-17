import { base44 } from "@/api/base44Client";

export async function logAudit({ event_id, action, entity_type, entity_id, details, user }) {
  try {
    await base44.entities.AuditLog.create({
      event_id: event_id || "",
      action,
      entity_type,
      entity_id: entity_id || "",
      user_id: user?.id || "",
      user_name: user?.full_name || user?.email || "",
      details: typeof details === "string" ? details : JSON.stringify(details || {}),
      ip_address: "",
    });
  } catch (e) {
    console.error("Audit log failed:", e);
  }
}
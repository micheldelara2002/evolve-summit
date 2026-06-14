import { base44 } from "@/api/base44Client";

async function getClientIp() {
  try {
    // Try to get IP from a reliable public API
    const res = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      return data.ip || "";
    }
  } catch {
    // fallback — no IP available
  }
  return "";
}

export async function logAudit({ event_id, action, entity_type, entity_id, details, user }) {
  try {
    const ip_address = await getClientIp();
    await base44.entities.AuditLog.create({
      event_id: event_id || "",
      action,
      entity_type,
      entity_id: entity_id || "",
      user_id: user?.id || "",
      user_name: user?.full_name || user?.email || "",
      details: typeof details === "string" ? details : JSON.stringify(details || {}),
      ip_address,
    });
  } catch (e) {
    console.error("Audit log failed:", e);
  }
}
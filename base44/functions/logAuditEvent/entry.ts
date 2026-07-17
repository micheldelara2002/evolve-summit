import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json();

    // Extract client IP from standard proxy headers
    const forwarded = req.headers.get("x-forwarded-for");
    const ip = (forwarded ? forwarded.split(",")[0].trim() : "")
             || req.headers.get("x-real-ip")
             || req.headers.get("cf-connecting-ip")
             || "";

    await base44.asServiceRole.entities.AuditLog.create({
      event_id: body.event_id || "",
      action: body.action,
      entity_type: body.entity_type,
      entity_id: body.entity_id || "",
      user_id: user.id,
      user_name: user.full_name || user.email || "",
      details: typeof body.details === "string" ? body.details : JSON.stringify(body.details || {}),
      ip_address: ip,
    });

    return Response.json({ ok: true });
  } catch (error) {
    // Audit failures should not crash the calling flow — log and return error
    console.error("logAuditEvent error:", error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
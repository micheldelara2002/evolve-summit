import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveUserPartnerManagerIds } from "../../shared/eventAuth.ts";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    if (user.role === 'admin') {
      const partners = await base44.asServiceRole.entities.Partner.list('-created_date', 500);
      return Response.json({ partners });
    }

    const ids = await resolveUserPartnerManagerIds(base44, user);
    if (!ids.length) return Response.json({ partners: [] });
    const all = await base44.asServiceRole.entities.Partner.filter({ id: { $in: ids } });
    all.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
    return Response.json({ partners: all });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canAccessPartnerData } from "../../shared/eventAuth.ts";

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { partnerId } = await req.json();
    if (!partnerId) return Response.json({ error: 'partnerId obrigatório.' }, { status: 400 });

    const ok = await canAccessPartnerData(base44, user, partnerId);
    if (!ok) return Response.json({ error: 'Sem permissão para acessar este parceiro.' }, { status: 403 });

    const list = await base44.asServiceRole.entities.Partner.filter({ id: partnerId });
    return Response.json({ partner: list?.[0] || null });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
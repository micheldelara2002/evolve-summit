import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canAccessEventData, verifyEventMembership, EVENT_MANAGER_ROLES, resolveUserPartnerIds } from "../../shared/eventAuth.ts";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { eventId } = await req.json();
    if (!eventId) return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });

    const ok = await canAccessEventData(base44, user, eventId);
    if (!ok) return Response.json({ error: 'Sem permissão para acessar sorteios deste evento.' }, { status: 403 });

    let raffles = await base44.asServiceRole.entities.Raffle.filter({
      event_id: eventId,
      is_deleted: false,
    });
    // 2026-09-29 — Representante de parceiro SEM papel de gestão vê apenas os
    // sorteios do PRÓPRIO estande (vencedores de outros parceiros não vazam).
    const isMgmt = user.role === 'admin' ||
      (await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES)).authorized;
    if (!isMgmt) {
      const partnerIds = await resolveUserPartnerIds(base44, user);
      if (partnerIds.length > 0) {
        raffles = raffles.filter((r) => r.context === 'partner' && partnerIds.includes(r.context_ref_id));
      }
    }
    return Response.json({ raffles });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
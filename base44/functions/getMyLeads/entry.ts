import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canAccessPartnerData } from "../../shared/eventAuth.ts";

// Lote 3 — Leads de um parceiro (leitura autorizada).
// Valida que o chamador é admin OU PartnerRepresentative ativo do partnerId
// (qualquer role_in_partner — managers e representatives leem leads).
// eventId opcional: filtra leads de um evento específico; sem ele, todos os eventos.
//
// Payload: { partnerId, eventId? }

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { partnerId, eventId } = body;
    if (!partnerId) return Response.json({ error: 'partnerId obrigatório.' }, { status: 400 });

    const ok = await canAccessPartnerData(base44, user, partnerId);
    if (!ok) return Response.json({ error: 'Sem permissão para acessar leads deste parceiro.' }, { status: 403 });

    const svc = base44.asServiceRole;
    const filter: any = { partner_id: partnerId };
    if (eventId) filter.event_id = eventId;
    const leads = await svc.entities.Lead.filter(filter, '-created_date', 10000);

    return Response.json({ leads });
  } catch (error: any) {
    console.error('[getMyLeads]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.54';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canAccessPartnerData, verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";

// 2026-11-04 — Representantes de um parceiro para a tela de vínculo com o
// evento. Além de admin/partner_manager do próprio parceiro, o GERENTE DO
// EVENTO também lê a lista: ele precisa escolher quais representantes viram
// Participant ao vincular a empresa. Nesse caso exige o eventId e valida o
// vínculo com o evento. Nome/e-mail vêm da Person (sem expor PII extra).
export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const { partnerId, eventId } = await req.json();
    if (!partnerId) return Response.json({ error: 'partnerId obrigatório.' }, { status: 400 });

    let allowed = await canAccessPartnerData(base44, user, partnerId);
    if (!allowed && eventId) {
      const managerAuth = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
      allowed = managerAuth.authorized;
    }
    if (!allowed) return Response.json({ error: 'Sem permissão.' }, { status: 403 });

    const representatives = await svc.entities.PartnerRepresentative.filter({
      partner_id: partnerId,
      is_deleted: false,
    });

    const personIds = [...new Set((representatives || []).map((r: any) => r.person_id).filter(Boolean))];
    const persons = personIds.length
      ? await svc.entities.Person.filter({ id: { $in: personIds } })
      : [];
    const personMap = new Map((persons || []).map((p: any) => [p.id, p]));

    const enriched = (representatives || []).map((r: any) => {
      const person: any = personMap.get(r.person_id);
      return {
        id: r.id,
        partner_id: r.partner_id,
        person_id: r.person_id,
        role_in_partner: r.role_in_partner,
        is_primary: !!r.is_primary,
        is_active: r.is_active !== false,
        full_name: person?.full_name || '',
        contact_email: person?.contact_email || '',
        photo_url: person?.photo_url || '',
      };
    });

    return Response.json({ representatives: enriched });
  } catch (error: any) {
    console.error('getPartnerRepresentatives error:', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
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
      const svc = base44.asServiceRole;
      const partnerIds = await resolveUserPartnerIds(base44, user);
      // Sorteios do PRÓPRIO palestrante (context='speaker' + participant próprio,
      // ancorado na membership speaker e/ou e-mail do usuário).
      const speakerMemberships = await svc.entities.EventMembership.filter({
        event_id: eventId, user_id: user.id, role: 'speaker', is_active: true, is_deleted: false,
      });
      const personIds = [...new Set((speakerMemberships || []).map((m) => m.person_id).filter(Boolean))];
      const [ownByPerson, ownByEmail] = await Promise.all([
        personIds.length
          ? svc.entities.Participant.filter({ event_id: eventId, is_deleted: false, person_id: { $in: personIds } })
          : Promise.resolve([]),
        user.email
          ? svc.entities.Participant.filter({ event_id: eventId, is_deleted: false, email: user.email })
          : Promise.resolve([]),
      ]);
      const ownPartIds = [...new Set([...(ownByPerson || []), ...(ownByEmail || [])].map((p) => p.id))];
      // Sem papel de gestão: apenas os próprios sorteios de estande OU de
      // palestrante — vencedores de outros parceiros/palestrantes não vazam.
      raffles = raffles.filter((r) =>
        (r.context === 'partner' && partnerIds.includes(r.context_ref_id)) ||
        (r.context === 'speaker' && ownPartIds.includes(r.context_ref_id)));
    }
    return Response.json({ raffles });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
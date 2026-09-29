import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES, canAccessPartnerData } from "../../shared/eventAuth.ts";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const svc = base44.asServiceRole;
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json();
    const { id, eventId, ...payload } = body;
    if (!eventId) return Response.json({ error: 'eventId é obrigatório.' }, { status: 400 });

    // P1 (auditoria 2026-09-28) — gate alinhado ao executeRaffle: manager/team
    // do PRÓPRIO evento (ou admin). O canAccessEventData anterior (nível
    // participante) permitia a qualquer participante gravar sorteios via API.
    const { authorized } = await verifyEventMembership(base44, user, eventId, EVENT_MANAGER_ROLES);
    if (!authorized) {
      // Caminho PARCEIRO (2026-09-29): partner_manager OU representative do
      // parceiro referenciado salva os próprios sorteios do estande, sem
      // depender do gerente/admin. Exige vínculo ativo com o parceiro
      // (context_ref_id) e parceiro ATIVO no evento (EventPartner).
      let existingRaffle = null;
      if (id) {
        existingRaffle = (await svc.entities.Raffle.filter({ id, is_deleted: false }))[0] || null;
      }
      const effContext = existingRaffle ? existingRaffle.context : payload.context;
      const effPartnerId = existingRaffle ? existingRaffle.context_ref_id : payload.context_ref_id;
      if (effContext !== 'partner' || !effPartnerId) {
        return Response.json({ error: 'Sem permissão para salvar sorteios neste evento.' }, { status: 403 });
      }
      const partnerOk = await canAccessPartnerData(base44, user, effPartnerId);
      if (!partnerOk) {
        return Response.json({ error: 'Sem permissão para salvar sorteios deste parceiro.' }, { status: 403 });
      }
      const link = await svc.entities.EventPartner.filter({
        event_id: eventId, partner_id: effPartnerId, is_active: true, is_deleted: false,
      });
      if (!link?.length) {
        return Response.json({ error: 'Parceiro não está ativo neste evento.' }, { status: 403 });
      }
      // Parceiro não pode alterar o contexto/titular de um sorteio existente.
      if (existingRaffle) {
        delete payload.context;
        delete payload.context_ref_id;
      }
    }

    if (id) {
      // Update path: revalidate that the existing raffle belongs to this event.
      const existing = await svc.entities.Raffle.filter({ id, is_deleted: false });
      if (!existing?.length) return Response.json({ error: 'Sorteio não encontrado.' }, { status: 404 });
      if (existing[0].event_id !== eventId) {
        return Response.json({ error: 'Sorteio não pertence a este evento.' }, { status: 403 });
      }
      await svc.entities.Raffle.update(id, { ...payload, event_id: eventId });
      return Response.json({ ok: true, id });
    }

    const created = await svc.entities.Raffle.create({ ...payload, event_id: eventId });
    return Response.json({ ok: true, id: created.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
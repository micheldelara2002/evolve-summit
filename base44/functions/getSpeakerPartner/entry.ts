import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

// Retorna a ficha pública do parceiro patrocinador do palestrante de uma sessão,
// se o palestrante for um representante ativo de um parceiro ativo do evento.
// Toda a lógica de cruzamento (Participant → PartnerRepresentative → EventPartner → Partner)
// roda server-side; nenhum dado de PartnerRepresentative vaza ao cliente.
function publicView(p) {
  return {
    id: p.id,
    trade_name: p.trade_name,
    legal_name: p.legal_name,
    logo_url: p.logo_url,
    website: p.website,
    about: p.about,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });

    const { eventId, speakerParticipantId } = await req.json();
    if (!eventId || !speakerParticipantId) return Response.json({ partner: null });

    // 1. Participant do palestrante
    const parts = await base44.asServiceRole.entities.Participant.filter({ id: speakerParticipantId, is_deleted: false });
    const sp = parts?.[0];
    if (!sp?.person_id || sp.role_in_event !== 'partner_rep') return Response.json({ partner: null });

    // 2. PartnerRepresentative ativo por person_id
    const reps = await base44.asServiceRole.entities.PartnerRepresentative.filter({
      person_id: sp.person_id,
      is_active: true,
      is_deleted: false,
    });
    if (!reps?.length) return Response.json({ partner: null });

    // 3. EventPartners ativos do evento
    const eventPartners = await base44.asServiceRole.entities.EventPartner.filter({
      event_id: eventId,
      is_active: true,
      is_deleted: false,
    });
    const activePartnerIds = new Set(eventPartners.map((ep) => ep.partner_id));

    // 4. Rep cujo partner está vinculado ao evento
    const rep = reps.find((r) => activePartnerIds.has(r.partner_id));
    if (!rep) return Response.json({ partner: null });

    // 5. Partner público
    const partners = await base44.asServiceRole.entities.Partner.filter({ id: rep.partner_id, is_active: true, is_deleted: false });
    return Response.json({ partner: partners?.[0] ? publicView(partners[0]) : null });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
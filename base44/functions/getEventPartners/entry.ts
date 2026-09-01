import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { canAccessEventData, canAccessPartnerData } from "../../shared/eventAuth.ts";

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const { eventId, partnerId } = await req.json();

    // Partner-scoped read: discover which events a partner is active in.
    // Used by partner_manager/representative dashboards (PainelParceiro, PartnerDashboard).
    if (!eventId && partnerId) {
      const ok = await canAccessPartnerData(base44, user, partnerId);
      if (!ok) return Response.json({ error: 'Sem permissão para acessar este parceiro.' }, { status: 403 });
      const eventPartners = await base44.asServiceRole.entities.EventPartner.filter({
        partner_id: partnerId,
        is_active: true,
        is_deleted: false,
      });
      return Response.json({ eventPartners });
    }

    // Event-scoped read: sponsors of a single event (optionally filtered by partner).
    if (eventId) {
      const ok = await canAccessEventData(base44, user, eventId);
      if (!ok) return Response.json({ error: 'Sem permissão para acessar este evento.' }, { status: 403 });
      const filter = { event_id: eventId, is_deleted: false };
      if (partnerId) filter.partner_id = partnerId;
      const eventPartners = await base44.asServiceRole.entities.EventPartner.filter(filter);
      return Response.json({ eventPartners });
    }

    return Response.json({ error: 'eventId ou partnerId é obrigatório.' }, { status: 400 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
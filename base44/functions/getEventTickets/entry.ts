import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { secrets } from "base44:runtime";
import { requireActiveUser } from "../../shared/accountSecurity.ts";

// Public/participant read of available ticket types + sales lots for an event.
// Respects sale windows (sale_start/sale_end) and excludes sold-out/inactive/deleted lots.
// Does NOT require admin — any authenticated user can browse a published event's tickets.
// Returns lots with computed remaining = quantity_total - quantity_reserved - quantity_sold.

function lotAvailable(lot: any, now: Date): boolean {
  if (!lot.is_active || lot.is_deleted) return false;
  if (lot.sale_start && new Date(lot.sale_start) > now) return false;
  if (lot.sale_end && new Date(lot.sale_end) < now) return false;
  const remaining = (lot.quantity_total || 0) - (lot.quantity_reserved || 0) - (lot.quantity_sold || 0);
  return remaining > 0;
}

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });

    const body = await req.json();
    const { eventId } = body;
    if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });

    const svc = base44.asServiceRole;
    const now = new Date();

    const [event, ticketTypes, lots] = await Promise.all([
      svc.entities.Event.filter({ id: eventId, is_deleted: false }),
      svc.entities.TicketType.filter({ event_id: eventId, is_active: true, is_deleted: false }),
      svc.entities.SalesLot.filter({ event_id: eventId, is_deleted: false }),
    ]);

    if (!event.length) return Response.json({ error: 'Evento não encontrado.' }, { status: 404 });

    const availableLots = lots
      .filter((l: any) => lotAvailable(l, now))
      .map((l: any) => ({
        id: l.id,
        ticket_type_id: l.ticket_type_id,
        name: l.name,
        price: l.price,
        currency: l.currency || 'BRL',
        sale_start: l.sale_start,
        sale_end: l.sale_end,
        quantity_total: l.quantity_total,
        remaining: (l.quantity_total || 0) - (l.quantity_reserved || 0) - (l.quantity_sold || 0),
      }));

    const types = ticketTypes.map((t: any) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      sort_order: t.sort_order || 0,
      lots: availableLots.filter((l: any) => l.ticket_type_id === t.id).sort((a: any, b: any) => (a.price || 0) - (b.price || 0)),
    })).filter((t: any) => t.lots.length > 0)
      .sort((a: any, b: any) => (a.sort_order || 0) - (b.sort_order || 0));

    return Response.json({
      requires_payment: event[0].requires_payment === true,
      publishable_key: secrets.get("STRIPE_PUBLISHABLE_KEY") || "",
      ticket_types: types,
    });
  } catch (error: any) {
    console.error('[getEventTickets]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
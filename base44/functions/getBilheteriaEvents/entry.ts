import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

// Bilheteria — lista eventos com ingressos efetivamente à venda.
// Sinal real: existe ao menos um SalesLot ativo, dentro da janela de venda,
// com remaining > 0. Independente do flag requires_payment (esse flag é um
// gate de inscrição, não o sinal de marketplace).
//
// Retorna: [{ id, name, description, start_date, end_date, location, logo_url,
//   color_primary, requires_payment, min_price }]
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });

    const svc = base44.asServiceRole;
    const now = new Date();

    const [events, lots] = await Promise.all([
      svc.entities.Event.filter({ status: 'active', is_deleted: false }),
      svc.entities.SalesLot.filter({ is_deleted: false, is_active: true }),
    ]);

    function lotAvailable(lot: any): boolean {
      if (lot.sale_start && new Date(lot.sale_start) > now) return false;
      if (lot.sale_end && new Date(lot.sale_end) < now) return false;
      const remaining = (lot.quantity_total || 0) - (lot.quantity_reserved || 0) - (lot.quantity_sold || 0);
      return remaining > 0;
    }

    // Map event_id -> set of available lot prices.
    const availByEvent: Record<string, number[]> = {};
    for (const l of lots) {
      if (!lotAvailable(l)) continue;
      if (!availByEvent[l.event_id]) availByEvent[l.event_id] = [];
      availByEvent[l.event_id].push(l.price || 0);
    }

    const result = events
      .filter((e: any) => availByEvent[e.id])
      .map((e: any) => {
        const prices = availByEvent[e.id];
        return {
          id: e.id,
          name: e.name,
          description: e.description || '',
          start_date: e.start_date || '',
          end_date: e.end_date || '',
          location: e.location || '',
          logo_url: e.logo_url || '',
          color_primary: e.color_primary || '#4F46E5',
          requires_payment: e.requires_payment === true,
          min_price: Math.min(...prices),
        };
      })
      .sort((a: any, b: any) => (a.min_price - b.min_price));

    return Response.json({ events: result });
  } catch (error: any) {
    console.error('[getBilheteriaEvents]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
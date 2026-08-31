import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { getPeriodRange, getPreviousRange, inRange, pctChange, dayKeyOf } from "../../shared/businessPeriod.ts";

// Métricas globais de vendas (admin): receita total, ingressos vendidos,
// ticket médio, pedidos pagos, série diária de receita, top eventos por receita.
// Filtros: period, customStart, customEnd, eventFilter.
//
// Volume de pagamentos é baixo (escala de eventos), então carregamos pagamentos
// succeeded + tickets e filtramos in-memory por created_date/succeeded_at.
//
// Payload: { period, customStart, customEnd, eventFilter }

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden — admin only' }, { status: 403 });

    const { period = '3m', customStart = '', customEnd = '', eventFilter = 'all' } = await req.json().catch(() => ({}));
    const current = getPeriodRange(period, customStart, customEnd);
    const previous = getPreviousRange(current.start, current.end);

    const svc = base44.asServiceRole;

    const [events, payments, orders, tickets] = await Promise.all([
      svc.entities.Event.filter({ is_deleted: false }, '-created_date', 5000),
      svc.entities.Payment.filter({ is_deleted: false }, undefined, 20000),
      svc.entities.Order.filter({}, '-created_date', 20000),
      svc.entities.Ticket.filter({ is_deleted: false }, undefined, 20000),
    ]);

    const evId = eventFilter !== 'all' ? eventFilter : null;
    const eventName = new Map(events.map((e: any) => [e.id, e.name]));

    const curSucceeded = payments.filter((p: any) =>
      p.status === 'succeeded' && inRange(p.succeeded_at || p.created_date, current.start, current.end) &&
      (!evId || p.event_id === evId)
    );
    const prevSucceeded = payments.filter((p: any) =>
      p.status === 'succeeded' && inRange(p.succeeded_at || p.created_date, previous.start, previous.end) &&
      (!evId || p.event_id === evId)
    );

    const revenueNow = curSucceeded.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    const revenuePrev = prevSucceeded.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    const ordersPaidNow = curSucceeded.length;
    const ordersPaidPrev = prevSucceeded.length;

    const curTickets = tickets.filter((t: any) =>
      (t.status === 'issued' || t.status === 'used') &&
      inRange(t.created_date, current.start, current.end) &&
      (!evId || t.event_id === evId)
    );
    const prevTickets = tickets.filter((t: any) =>
      (t.status === 'issued' || t.status === 'used') &&
      inRange(t.created_date, previous.start, previous.end) &&
      (!evId || t.event_id === evId)
    );

    const avgTicketNow = ordersPaidNow > 0 ? revenueNow / ordersPaidNow : 0;
    const avgTicketPrev = ordersPaidPrev > 0 ? revenuePrev / ordersPaidPrev : 0;

    const dailyMap = new Map<string, number>();
    for (const p of curSucceeded) {
      const k = dayKeyOf(p.succeeded_at || p.created_date);
      dailyMap.set(k, (dailyMap.get(k) || 0) + (Number(p.amount) || 0));
    }
    const revenueDaily = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, revenue]) => ({ date: date.slice(8, 10) + '/' + date.slice(5, 7), revenue: Math.round(revenue * 100) / 100 }));

    const byEvent = new Map<string, number>();
    for (const p of payments) {
      if (p.status !== 'succeeded') continue;
      if (evId && p.event_id !== evId) continue;
      byEvent.set(p.event_id, (byEvent.get(p.event_id) || 0) + (Number(p.amount) || 0));
    }
    const topEvents = Array.from(byEvent.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, revenue]) => ({ id, name: eventName.get(id) || 'Evento removido', revenue: Math.round(revenue * 100) / 100 }));

    return Response.json({
      kpis: {
        revenue: { value: Math.round(revenueNow * 100) / 100, delta: pctChange(revenueNow, revenuePrev) },
        ticketsSold: { value: curTickets.length, delta: pctChange(curTickets.length, prevTickets.length) },
        avgTicket: { value: Math.round(avgTicketNow * 100) / 100, delta: pctChange(avgTicketNow, avgTicketPrev) },
        ordersPaid: { value: ordersPaidNow, delta: pctChange(ordersPaidNow, ordersPaidPrev) },
      },
      revenueDaily,
      topEvents,
    });
  } catch (error: any) {
    console.error('[getSalesMetrics]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { getPeriodRange, getPreviousRange, inRange, pctChange, dayKeyOf } from "../../shared/businessPeriod.ts";
import { scanAll } from "../../shared/completeScan.ts";

// Métricas globais de vendas (admin): receita total, ingressos vendidos,
// ticket médio, pedidos pagos, série diária de receita, top eventos por receita.
// Filtros: period, customStart, customEnd, eventFilter.
//
// PERF-001 (2026-09-28) — FIM da truncagem silenciosa:
//   - Orders REMOVIDOS do carregamento (nunca eram usados no cálculo — todos
//     os KPIs vêm de Payment succeeded; "pedidos pagos" conta pagamentos);
//   - Payment/Ticket/Event carregados com VARREDURA COMPLETA paginada por id
//     (scanAll) — nenhum limite 10000/20000 silencioso;
//   - filtros movidos para a QUERY (payment status 'succeeded'; ingressos
//     'issued'/'used') — menos registros por página, mesmo resultado;
//   - a resposta informa consultas executadas e completude (scan.*) —
//     medição antes/depois auditável.
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

    // Varredura completa — TODO cálculo usa somente pagamentos succeeded e
    // ingressos issued/used; eventos para o mapa de nomes. Sem Orders.
    const [eventsScan, paymentsScan, ticketsScan] = await Promise.all([
      scanAll(svc.entities.Event, { is_deleted: false }),
      scanAll(svc.entities.Payment, { status: 'succeeded', is_deleted: false }),
      scanAll(svc.entities.Ticket, { status: { $in: ['issued', 'used'] }, is_deleted: false }),
    ]);
    const events = eventsScan.items;
    const payments = paymentsScan.items;
    const tickets = ticketsScan.items;

    const evId = eventFilter !== 'all' ? eventFilter : null;
    const eventName = new Map(events.map((e: any) => [e.id, e.name]));

    const curSucceeded = payments.filter((p: any) =>
      inRange(p.succeeded_at || p.created_date, current.start, current.end) &&
      (!evId || p.event_id === evId)
    );
    const prevSucceeded = payments.filter((p: any) =>
      inRange(p.succeeded_at || p.created_date, previous.start, previous.end) &&
      (!evId || p.event_id === evId)
    );

    const revenueNow = curSucceeded.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    const revenuePrev = prevSucceeded.reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
    const ordersPaidNow = curSucceeded.length;
    const ordersPaidPrev = prevSucceeded.length;

    const curTickets = tickets.filter((t: any) =>
      inRange(t.created_date, current.start, current.end) &&
      (!evId || t.event_id === evId)
    );
    const prevTickets = tickets.filter((t: any) =>
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
      scan: {
        payments: { records: payments.length, queries: paymentsScan.queries, complete: paymentsScan.complete },
        tickets: { records: tickets.length, queries: ticketsScan.queries, complete: ticketsScan.complete },
        events: { records: events.length, queries: eventsScan.queries, complete: eventsScan.complete },
        orders_loaded: 0,
      },
    });
  } catch (error: any) {
    console.error('[getSalesMetrics]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
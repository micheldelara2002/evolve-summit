import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_FINANCE_ROLES } from "../../shared/eventAuth.ts";
import { fetchPage, countAll, scanAll } from "../../shared/completeScan.ts";

// P2 (2026-09-29) — Sanitização de Payment para respostas a gestores de evento
// (superfície não-admin): WHITELIST — só os campos de gestão saem. client_secret,
// intent_id e outros identificadores internos do Stripe nunca chegam ao cliente,
// nem por engano futuro (um campo novo no schema só aparece aqui se for
// adicionado explicitamente). NUNCA use blacklist nesta superfície.
// (Fundida aqui: era módulo shared usado por uma única função.)
const MANAGER_PAYMENT_FIELDS = [
  "id", "order_id", "event_id", "amount", "currency", "status", "provider",
  "payment_method", "refunded_amount", "fulfillment_status", "error_reason",
  "succeeded_at", "created_date",
];

function sanitizePayment(p: any): any {
  if (!p) return null;
  const out: any = {};
  for (const f of MANAGER_PAYMENT_FIELDS) {
    if (p[f] !== undefined) out[f] = p[f];
  }
  // Visão de gestão que o organizador precisa por venda:
  // bruto − comissão da plataforma − taxa do Stripe = líquido.
  const applicationFee = Number(p.application_fee_amount || 0);
  const stripeFee = Number(p.stripe_fee_amount || 0);
  out.application_fee_amount = applicationFee;
  out.stripe_fee_amount = stripeFee;
  out.net_amount = Math.max(0, Number((Number(p.amount || 0) - applicationFee - stripeFee).toFixed(2)));
  return out;
}

function sanitizePayments(payments: any[]): any[] {
  return (payments || []).map((p: any) => sanitizePayment(p)).filter(Boolean);
}

// Visão detalhada de vendas de um evento: pedidos pagos com itens, titulares,
// ticket_id, hash_code, status e comprador (buyer_name/email). "Quem comprou
// o quê, quando e quanto pagou." Admin ou gerente do evento.
//
// PERF-001 (2026-09-28) — paginação backend OBRIGATÓRIA (fim da truncagem
// silenciosa de 10.000 registros completos):
//   - pedidos e pagamentos são fluxos paginados INDEPENDENTES (sort '-id',
//     cursor id $lt); a resposta informa total exato, limite, cursores e
//     has_more — nunca 10 mil itens sem controle;
//   - itens/ingressos são carregados SOMENTE para os pedidos da página
//     (varredura completa por order_id $in — sem teto silencioso);
//   - isolamento por evento (verifyEventMembership) e sanitização de dados de
//     pagamento (sanitizePayments) preservados; valores financeiros e regras
//     de Stripe/comissão/estorno intactos.
//
// Payload: { eventId, limit?, ordersCursor?, paymentsCursor? }
//   limit: 1..500 (default 200)
//   cursor ausente/null → primeira página; '' (vazio) → fluxo encerrado.
// O wrapper do frontend (commerceApi.getEventOrders) percorre as páginas até
// esgotar — os consumidores recebem a lista completa como antes.

const MAX_LIMIT = 500;

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;

    const body = await req.json().catch(() => ({}));
    const { eventId } = body;
    if (!eventId) return Response.json({ error: 'eventId obrigatório.' }, { status: 400 });

    const { authorized } = await verifyEventMembership(base44, user, eventId, EVENT_FINANCE_ROLES);
    if (!authorized) return Response.json({ error: 'Sem permissão para este evento.' }, { status: 403 });

    const svc = base44.asServiceRole;

    const limit = Math.min(Math.max(Number(body.limit) || 200, 1), MAX_LIMIT);
    const ordersCursor = body.ordersCursor === undefined || body.ordersCursor === null ? null : String(body.ordersCursor);
    const paymentsCursor = body.paymentsCursor === undefined || body.paymentsCursor === null ? null : String(body.paymentsCursor);
    const isFirstPage = ordersCursor === null && paymentsCursor === null;

    // Semântica preservada do código anterior: Order sem filtro is_deleted,
    // Payment/OrderItem/Ticket com is_deleted: false.
    const ordersQuery = { event_id: eventId };
    const paymentsQuery = { event_id: eventId, is_deleted: false };

    const [ordersPage, paymentsPage, totalCount] = await Promise.all([
      fetchPage(svc.entities.Order, ordersQuery, ordersCursor, limit),
      fetchPage(svc.entities.Payment, paymentsQuery, paymentsCursor, limit),
      isFirstPage ? countAll(svc.entities.Order, ordersQuery) : Promise.resolve(null),
    ]);

    // Itens e ingressos apenas dos pedidos DESTA página — varredura completa
    // (nenhum teto silencioso entre pedido e seus itens).
    const pageOrderIds = ordersPage.page.map((o: any) => o.id);
    let items: any[] = [];
    let tickets: any[] = [];
    if (pageOrderIds.length > 0) {
      const itemsScan = await scanAll(svc.entities.OrderItem, { order_id: { $in: pageOrderIds }, is_deleted: false });
      items = itemsScan.items;
      const itemIds = items.map((it: any) => it.id);
      if (itemIds.length > 0) {
        const ticketsScan = await scanAll(svc.entities.Ticket, { order_item_id: { $in: itemIds }, is_deleted: false });
        tickets = ticketsScan.items;
      }
    }

    const itemByOrder = new Map<string, any[]>();
    for (const it of items) {
      const arr = itemByOrder.get(it.order_id) || [];
      arr.push(it);
      itemByOrder.set(it.order_id, arr);
    }
    const ticketByItem = new Map<string, any>();
    for (const t of tickets) ticketByItem.set(t.order_item_id, t);
    const payByOrder = new Map<string, any>();
    for (const p of paymentsPage.page) payByOrder.set(p.order_id, p);

    const detailed = ordersPage.page.map((o: any) => {
      const oItems = (itemByOrder.get(o.id) || []).map((it: any) => {
        const tk = ticketByItem.get(it.id);
        return {
          id: it.id,
          ticket_type_name: it.ticket_type_name,
          lot_id: it.lot_id,
          holder_name: it.holder_name,
          holder_email: it.holder_email,
          holder_phone: it.holder_phone || '',
          unit_price: it.unit_price,
          refunded: !!it.refunded,
          ticket_id: tk?.id || '',
          hash_code: tk?.hash_code || '',
          ticket_status: tk?.status || '',
          used_at: tk?.used_at || '',
        };
      });
      const payment = payByOrder.get(o.id);
      return {
        id: o.id,
        buyer_name: o.buyer_name,
        buyer_email: o.buyer_email,
        status: o.status,
        total: o.total,
        subtotal: o.subtotal,
        discount: o.discount,
        coupon_code: o.coupon_code,
        created_date: o.created_date,
        payment_status: payment?.status || '',
        payment_method: payment?.payment_method || '',
        payment_id: payment?.id || '',
        items: oItems,
      };
    });

    // payments: visão sanitizada de Payment (whitelist — sem client_secret,
    // intent_id ou IDs internos do Stripe; RLS admin/buyer bloqueia leitura
    // direta pelo gerente, então a aba Transações usa esta lista).
    const sortedPayments = sanitizePayments(paymentsPage.page).sort(
      (a: any, b: any) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime()
    );

    return Response.json({
      orders: detailed,
      payments: sortedPayments,
      total: totalCount ? totalCount.total : undefined,
      total_complete: totalCount ? totalCount.complete : undefined,
      limit,
      orders_cursor: ordersPage.nextCursor,
      payments_cursor: paymentsPage.nextCursor,
      has_more: ordersPage.hasMore || paymentsPage.hasMore,
    });
  } catch (error: any) {
    console.error('[getEventOrders]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
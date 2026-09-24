import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";

// Visão de transações (somente admin) — usado pelo painel de auditoria.
// Recebe uma busca (ID do pedido, ID do pagamento, intent_id do Stripe pi_...,
// refund re_..., ID da solicitação de estorno ou e-mail do comprador), resolve o
// pedido correspondente e devolve a linha do tempo completa da transação:
// estado atual do pedido/pagamentos/estornos + todas as entradas de auditoria
// relacionadas, em ordem cronológica.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    if (guard.user.role !== 'admin') {
      return Response.json({ error: 'Sem permissão.' }, { status: 403 });
    }
    const svc = base44.asServiceRole;

    const body = await req.json().catch(() => ({} as any));
    const q = String((body as any)?.query || '').trim();
    if (!q) return Response.json({ matches: [], trail: null });

    const orderSummary = (o: any) => ({
      order_id: o.id,
      buyer_name: o.buyer_name || '',
      buyer_email: o.buyer_email || '',
      event_id: o.event_id || '',
      total: o.total || 0,
      status: o.status || '',
      created_date: o.created_date,
    });

    // Resolve a busca para um pedido: id direto, pagamento (id ou intent),
    // solicitação de estorno (id ou refund Stripe), ou e-mail do comprador.
    // Filtros por 'id' só com formato válido (o SDK rejeita id inválido com erro
    // em vez de devolver vazio) — buscas por e-mail/intent/refund sempre seguem.
    let order: any = null;
    const isObjectId = /^[0-9a-f]{24}$/i.test(q);

    if (isObjectId) {
      order = (await svc.entities.Order.filter({ id: q }))[0] || null;
      if (!order) {
        const payment = (await svc.entities.Payment.filter({ id: q }))[0] || null;
        if (payment) order = (await svc.entities.Order.filter({ id: payment.order_id }))[0] || null;
      }
      if (!order) {
        const rr = (await svc.entities.RefundRequest.filter({ id: q }))[0] || null;
        if (rr) order = (await svc.entities.Order.filter({ id: rr.order_id }))[0] || null;
      }
    }
    if (!order) {
      const payment = (await svc.entities.Payment.filter({ intent_id: q }))[0] || null;
      if (payment) order = (await svc.entities.Order.filter({ id: payment.order_id }))[0] || null;
    }
    if (!order) {
      const rr = (await svc.entities.RefundRequest.filter({ stripe_refund_id: q }))[0] || null;
      if (rr) order = (await svc.entities.Order.filter({ id: rr.order_id }))[0] || null;
    }
    if (!order) {
      const byEmail = await svc.entities.Order.filter({ buyer_email: q, is_deleted: false });
      if (byEmail.length === 1) {
        order = byEmail[0];
      } else if (byEmail.length > 1) {
        byEmail.sort((a: any, b: any) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime());
        return Response.json({ matches: byEmail.slice(0, 10).map(orderSummary), trail: null });
      }
    }
    if (!order) return Response.json({ matches: [], trail: null });

    // Estado atual das entidades da transação.
    const payments = await svc.entities.Payment.filter({ order_id: order.id, is_deleted: false });
    const refundReqs = await svc.entities.RefundRequest.filter({ order_id: order.id, is_deleted: false });
    const event = (await svc.entities.Event.filter({ id: order.event_id }))[0] || null;

    // Trail: todas as entradas de auditoria do pedido, dos pagamentos e das
    // solicitações de estorno dele, em ordem cronológica.
    const payIds = payments.map((p: any) => p.id);
    const reqIds = refundReqs.map((r: any) => r.id);
    // P3 — Queries escopadas por event_id (todas as entradas de comércio gravam
    // event_id): restringe a varredura do AuditLog em vez de casar entity_id
    // globalmente — degrada menos com o volume de entradas.
    const audits: any[] = [];
    audits.push(...await svc.entities.AuditLog.filter({ entity_type: 'Order', entity_id: order.id, event_id: order.event_id }));
    if (payIds.length > 0) audits.push(...await svc.entities.AuditLog.filter({ entity_type: 'Payment', entity_id: { $in: payIds }, event_id: order.event_id }));
    if (reqIds.length > 0) audits.push(...await svc.entities.AuditLog.filter({ entity_type: 'RefundRequest', entity_id: { $in: reqIds }, event_id: order.event_id }));
    audits.sort((a: any, b: any) => new Date(a.created_date).getTime() - new Date(b.created_date).getTime());

    return Response.json({
      matches: [orderSummary(order)],
      order: {
        ...orderSummary(order),
        event_name: event?.name || '',
        subtotal: order.subtotal || 0,
        discount: order.discount || 0,
        coupon_code: order.coupon_code || '',
        fulfillment_status: order.fulfillment_status || '',
        error_reason: order.error_reason || '',
        reserved_until: order.reserved_until || '',
      },
      payments: payments.map((p: any) => ({
        id: p.id,
        intent_id: p.intent_id || '',
        charge_id: p.charge_id || '',
        amount: p.amount || 0,
        status: p.status || '',
        payment_method: p.payment_method || '',
        refunded_amount: p.refunded_amount || 0,
        stripe_fee_amount: p.stripe_fee_amount || 0,
        application_fee_amount: p.application_fee_amount || 0,
        destination_account_id: p.destination_account_id || '',
        fulfillment_status: p.fulfillment_status || '',
        error_reason: p.error_reason || '',
        succeeded_at: p.succeeded_at || '',
        created_date: p.created_date,
      })),
      refund_requests: refundReqs.map((r: any) => ({
        id: r.id,
        refund_type: r.refund_type || '',
        amount_requested: r.amount_requested || 0,
        amount_refunded: r.amount_refunded || 0,
        status: r.status || '',
        reason: r.reason || '',
        requested_by_name: r.requested_by_name || '',
        stripe_refund_id: r.stripe_refund_id || '',
        policy_decision: r.policy_decision || '',
        rejection_reason: r.rejection_reason || '',
        created_date: r.created_date,
        processed_at: r.processed_at || '',
      })),
      trail: audits.map((a: any) => ({
        id: a.id,
        created_date: a.created_date,
        action: a.action || '',
        entity_type: a.entity_type || '',
        entity_id: a.entity_id || '',
        user_id: a.user_id || '',
        user_name: a.user_name || '',
        ip_address: a.ip_address || '',
        details: a.details || '',
      })),
    });
  } catch (error: any) {
    console.error('[getTransactionTrail]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
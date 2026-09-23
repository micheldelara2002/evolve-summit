import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { verifyEventMembership, EVENT_MANAGER_ROLES } from "../../shared/eventAuth.ts";
import { fulfillOrder } from "../../shared/commerceFulfillment.ts";
import { deliverTickets } from "../../shared/ticketPdf.ts";

// P2 — Retry de fulfillment: pedido PAGO cuja emissão de ingressos/participantes
// falhou (Payment.fulfillment_status 'pending_retry' — o dinheiro do comprador
// é real, nada se perde). Autorização: comprador do pedido, admin, ou
// gestor/equipe do evento (EventMembership).
//
// O claim é resetado de forma atômica (pending_retry → pending): só um retry roda
// por vez; a reemissão reaproveita a lógica idempotente de fulfillOrder (por item)
// e a entrega de e-mails é idempotente por marcador.

export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;

    const body = await req.json();
    const { paymentId } = body;
    if (!paymentId) return Response.json({ error: 'paymentId obrigatório.' }, { status: 400 });

    const payment = (await svc.entities.Payment.filter({ id: paymentId }))[0];
    if (!payment) return Response.json({ error: 'Pagamento não encontrado.' }, { status: 404 });

    // Autorização: comprador, admin ou gestor/equipe do evento.
    if (payment.buyer_user_id !== user.id && user.role !== 'admin') {
      const mgrAuth = await verifyEventMembership(base44, user, payment.event_id, EVENT_MANAGER_ROLES);
      if (!mgrAuth.authorized) {
        return Response.json({ error: 'Sem permissão.' }, { status: 403 });
      }
    }

    if (payment.status !== 'succeeded') {
      return Response.json({ error: 'Este pagamento ainda não foi confirmado.' }, { status: 400 });
    }
    if (payment.fulfillment_status === 'fulfilled') {
      return Response.json({ ok: true, fulfilled: true, reason: 'already_fulfilled' });
    }
    if (payment.fulfillment_status !== 'pending_retry') {
      return Response.json({ error: 'Este pagamento não está em recuperação de emissão.' }, { status: 400 });
    }

    // Reset atômico do claim: pending_retry → pending. Se outro retry já resetou,
    // o guard falha e esta chamada não roda em paralelo.
    const reset = await svc.entities.Payment.updateMany(
      { id: payment.id, fulfillment_status: 'pending_retry' },
      { $set: { fulfillment_status: 'pending' } }
    );
    if (!reset || !reset.updated) {
      return Response.json({ error: 'Outra retentativa está em andamento. Atualize a página em instantes.' }, { status: 409 });
    }

    const order = (await svc.entities.Order.filter({ id: payment.order_id }))[0];
    if (!order) return Response.json({ error: 'Pedido não encontrado.' }, { status: 404 });
    const orderItems = await svc.entities.OrderItem.filter({ order_id: order.id, is_deleted: false });

    const result = await fulfillOrder(svc, { ...payment, fulfillment_status: 'pending' }, order, orderItems);

    if (result.fulfilled) {
      // Entrega dos ingressos por e-mail — idempotente por marcador de envio.
      try {
        const event = (await svc.entities.Event.filter({ id: order.event_id }))[0];
        await deliverTickets(svc, event, order, result.tickets, orderItems);
      } catch (delivErr: any) {
        console.error('[retryFulfillment] ticket delivery failed:', delivErr?.message || delivErr);
      }
      return Response.json({ ok: true, fulfilled: true, tickets: result.tickets.length });
    }

    return Response.json({ ok: false, fulfilled: false, error: result.error || 'Falha na emissão dos ingressos.' }, { status: 422 });
  } catch (error: any) {
    console.error('[retryFulfillment]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
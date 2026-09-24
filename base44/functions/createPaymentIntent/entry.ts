import { createClientFromRequest } from 'npm:@base44/sdk@0.8.44';
import { requireActiveUser } from "../../shared/accountSecurity.ts";
import { resolveCallerPerson } from "../../shared/sessionAuth.ts";
import { calculateCart, toCents } from "../../shared/commercePolicy.ts";
import { findActiveDuplicateEmails } from "../../shared/participantDedup.ts";
// (dedup: 1 e-mail ativo = 1 inscrição por evento — validação server-side)
import { createPaymentIntent, cancelPaymentIntent } from "../../shared/stripeClient.ts";
import { fulfillOrder, ensureCompanionInvites } from "../../shared/commerceFulfillment.ts";
import { extractClientIp, writeAudit } from "../../shared/commerceAudit.ts";

// Creates an Order + OrderItems + Stripe PaymentIntent for a cart of tickets.
// Reserves lot quantities atomically (cannot oversell). Returns the client secret
// for in-app Stripe Elements (Pix + card, no redirect).
//
// Payload:
//   eventId, items: [{ lot_id, ticket_type_id, holder_name, holder_email }], couponCode?
//
// Transaction safety:
//   - Lot reservation uses conditional updateMany with a $lte guard on quantity_reserved.
//     If the guard fails (someone else grabbed the last tickets), the order is aborted
//     and any reservations already made are rolled back.
//   - Single active order: a duplicate call reuses the buyer's pending order for the
//     same event — old PaymentIntents are cancelled in Stripe, so two orders are
//     never payable at the same time (no double-charge on reload/two tabs).
export default async function(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const guard = await requireActiveUser(base44);
    if (!guard.ok) return Response.json({ error: guard.error }, { status: guard.status });
    const user = guard.user;
    const svc = base44.asServiceRole;
    const clientIp = extractClientIp(req);

    const body = await req.json();
    const { eventId, items, couponCode } = body;
    if (!eventId || !Array.isArray(items) || items.length === 0) {
      return Response.json({ error: 'Carrinho vazio.' }, { status: 400 });
    }

    // P0 — Teto de itens por pedido (anti-abuso: pedido gigante drena créditos
    // e trava lotes inteiros com reservas).
    if (items.length > 20) {
      return Response.json({ error: 'Máximo de 20 ingressos por pedido.' }, { status: 400 });
    }

    // P0 — Normalização + limites dos dados do titular (nome ≤120, e-mail ≤254
    // com formato válido, telefone ≤30): entrada inválida nunca cria pedido
    // nem consome reserva.
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const it of items) {
      if (!it.lot_id || !it.holder_name || !it.holder_email || !it.holder_phone) {
        return Response.json({ error: 'Cada ingresso precisa de lote, nome, email e telefone do titular.' }, { status: 400 });
      }
      const hName = String(it.holder_name).trim();
      const hEmail = String(it.holder_email).trim().toLowerCase();
      const hPhone = String(it.holder_phone).trim();
      if (hName.length < 2 || hName.length > 120) {
        return Response.json({ error: 'Nome do titular inválido (entre 2 e 120 caracteres).' }, { status: 400 });
      }
      if (hEmail.length > 254 || !EMAIL_RE.test(hEmail)) {
        return Response.json({ error: 'E-mail do titular inválido.' }, { status: 400 });
      }
      if (hPhone.length < 8 || hPhone.length > 30) {
        return Response.json({ error: 'Telefone do titular inválido.' }, { status: 400 });
      }
      it.holder_name = hName;
      it.holder_email = hEmail;
      it.holder_phone = hPhone;
    }

    // Resolve buyer person.
    const buyerPersonId = await resolveCallerPerson(svc, user);
    const event = (await svc.entities.Event.filter({ id: eventId, is_deleted: false }))[0];
    if (!event) return Response.json({ error: 'Evento não encontrado.' }, { status: 404 });
    // Tickets só são vendidos se o evento estiver ativo (não draft, não finalizado, não cancelado).
    if (event.status !== 'active') {
      return Response.json({ error: 'Ingressos não estão à venda para este evento.' }, { status: 400 });
    }

    // P0 — Deduplicidade (bloqueio com reativação): 1 e-mail ATIVO = 1 inscrição
    // por evento. Validado no servidor ANTES de reservar estoque. Mesmo e-mail em
    // dois itens do carrinho é rejeitado; e-mail com inscrição ativa no evento
    // bloqueia a nova compra (cancelada/reembolsada permite nova inscrição).
    const seenCartEmails = new Set<string>();
    for (const it of items) {
      if (seenCartEmails.has(it.holder_email)) {
        return Response.json({ error: `Cada ingresso precisa de um titular diferente — "${it.holder_email}" aparece mais de uma vez no carrinho.` }, { status: 400 });
      }
      seenCartEmails.add(it.holder_email);
    }
    const activeDup = await findActiveDuplicateEmails(svc, eventId, items.map((i: any) => i.holder_email));
    if (activeDup.size > 0) {
      return Response.json({ error: `Não foi possível concluir: ${[...activeDup].join(', ')} já possui inscrição ativa neste evento (1 e-mail = 1 inscrição por evento).` }, { status: 409 });
    }

    // Stripe Connect: evento vinculado a uma conta conectada do organizador?
    // Se vinculado mas sem verificação concluída, bloqueamos a venda com mensagem
    // clara (o destination charge falharia no Stripe de qualquer forma).
    let destinationAccountId = '';
    if (event.payout_account_id) {
      const payoutAccount = (await svc.entities.PayoutAccount.filter({ id: event.payout_account_id, is_deleted: false }))[0];
      if (!payoutAccount || !payoutAccount.stripe_account_id || !payoutAccount.charges_enabled) {
        return Response.json({ error: 'O recebedor deste evento ainda não concluiu a verificação da conta de recebimento. Vendas temporariamente indisponíveis.' }, { status: 400 });
      }
      destinationAccountId = payoutAccount.stripe_account_id;
    }

    const now = new Date();

    // ===== Pedido único ativo: reusa o pedido pendente anterior =====
    // Se existir um pedido 'pending' anterior do mesmo comprador neste evento,
    // ele é reaproveitado: PaymentIntents antigos são cancelados no Stripe (nunca
    // dois pedidos pagáveis), reservas antigas são liberadas e itens antigos
    // invalidados. Se um PaymentIntent antigo já teve sucesso, o pedido antigo
    // fica intacto (o webhook vai fulfillá-lo) e um novo pedido é criado.
    let reusableOrder: any = null;
    const prevOrders = await svc.entities.Order.filter({ buyer_user_id: user.id, event_id: eventId, status: 'pending', is_deleted: false });
    if (prevOrders.length > 0) {
      prevOrders.sort((a: any, b: any) => new Date(b.created_date).getTime() - new Date(a.created_date).getTime());
      const prev = prevOrders[0];
      // Checa TODOS os pagamentos do pedido anterior (não só os 'pending'):
      // um pagamento 'succeeded' (ou em fulfillment pending_retry/fulfilled)
      // significa que o pedido foi PAGO — fica intacto (webhook cuida) e um
      // pedido NOVO é criado para este carrinho.
      const prevPayments = await svc.entities.Payment.filter({ order_id: prev.id, is_deleted: false });
      const paidSibling = prevPayments.some((p: any) =>
        p.status === 'succeeded' || p.fulfillment_status === 'pending_retry' || p.fulfillment_status === 'fulfilled'
      );
      if (!paidSibling) {
        // Claim atômico do reuso (CAS sobre reserved_until, que é atualizado de
        // qualquer forma no reuso): duas abas concorrentes NÃO empilham itens no
        // mesmo pedido — a segunda recebe 409 em vez de duplicar o checkout.
        const claimQuery = prev.reserved_until
          ? { id: prev.id, status: 'pending', reserved_until: prev.reserved_until }
          : { id: prev.id, status: 'pending' };
        const claimed = await svc.entities.Order.updateMany(claimQuery, {
          $set: { reserved_until: new Date(Date.now() + 15 * 60 * 1000).toISOString() },
        });
        if (!claimed || !claimed.updated) {
          return Response.json({ error: 'Outro checkout deste evento acabou de começar (outra aba/dispositivo). Tente novamente em instantes.' }, { status: 409 });
        }
        let alreadyPaid = false;
        for (const pp of prevPayments) {
          if (pp.status !== 'pending') continue;
          if (String(pp.intent_id || '').startsWith('free_')) {
            try { await svc.entities.Payment.update(pp.id, { status: 'expired', error_reason: 'Checkout reaberto com novo carrinho.' }); } catch {}
            continue;
          }
          try {
            await cancelPaymentIntent(pp.intent_id);
            await svc.entities.Payment.update(pp.id, { status: 'expired', error_reason: 'Checkout reaberto com novo carrinho.' });
          } catch (err: any) {
            if (/succeeded|captured/i.test(String(err?.message || ''))) {
              alreadyPaid = true; // pedido antigo foi pago entre a leitura e agora — webhook cuida
              break;
            }
            // ABORTA o re-checkout (P3): sem cancelar o intent antigo ficariam
            // DOIS intents pagáveis sobre o mesmo pedido (risco de dupla cobrança).
            // Nunca prossegue engolindo a falha.
            console.error('[createPaymentIntent] cancel old intent failed:', err?.message || err);
            return Response.json({ error: 'Não foi possível encerrar o pagamento anterior. Tente novamente em instantes.' }, { status: 502 });
          }
        }
        if (!alreadyPaid) {
          const prevItems = await svc.entities.OrderItem.filter({ order_id: prev.id, is_deleted: false });
          for (const it of prevItems) {
            try {
              await svc.entities.SalesLot.updateMany(
                { id: it.lot_id, quantity_reserved: { $gte: 1 } },
                { $inc: { quantity_reserved: -1 } }
              );
            } catch {}
            try { await svc.entities.OrderItem.update(it.id, { is_deleted: true }); } catch {}
          }
          // Trail — deixa rastro do carrinho anterior invalidado no re-checkout.
          await writeAudit(svc, {
            action: 'update',
            entity_type: 'Order',
            entity_id: prev.id,
            user_id: user.id,
            user_name: user.full_name || user.email || '',
            event_id: eventId,
            ip_address: clientIp,
            details: JSON.stringify({
              type: 'checkout_reaberto',
              itens_invalidados: prevItems.length,
              itens_anteriores: prevItems.map((i: any) => ({ tipo: i.ticket_type_name, titular: i.holder_name, email: i.holder_email })),
              total_anterior: prev.total,
            }),
          });
          reusableOrder = prev;
        }
      }
    }

    // Fetch all lots + ticket types referenced.
    const lotIds = [...new Set(items.map((i: any) => i.lot_id))];
    const lots = await svc.entities.SalesLot.filter({ id: { $in: lotIds }, event_id: eventId, is_deleted: false });
    const lotById: Record<string, any> = {};
    for (const l of lots) lotById[l.id] = l;

    // Validate lots are within sale window and available.
    for (const it of items) {
      const lot = lotById[it.lot_id];
      if (!lot || !lot.is_active) return Response.json({ error: 'Lote indisponível.' }, { status: 400 });
      if (lot.sale_start && new Date(lot.sale_start) > now) return Response.json({ error: `Lote "${lot.name}" ainda não está aberto.` }, { status: 400 });
      if (lot.sale_end && new Date(lot.sale_end) < now) return Response.json({ error: `Lote "${lot.name}" encerrado.` }, { status: 400 });
    }

    // Count per-lot demand for reservation guard.
    const demandByLot: Record<string, number> = {};
    for (const it of items) demandByLot[it.lot_id] = (demandByLot[it.lot_id] || 0) + 1;

    // Check availability first (fast-fail).
    for (const lotId of Object.keys(demandByLot)) {
      const lot = lotById[lotId];
      const remaining = (lot.quantity_total || 0) - (lot.quantity_reserved || 0) - (lot.quantity_sold || 0);
      if (remaining < demandByLot[lotId]) {
        return Response.json({ error: `Lote "${lot.name}" não tem ingressos suficientes (${remaining} disponíveis).` }, { status: 409 });
      }
    }

    // Atomically reserve quantities per lot with a $lte guard.
    const reservedLots: string[] = [];
    for (const lotId of Object.keys(demandByLot)) {
      const lot = lotById[lotId];
      const qty = demandByLot[lotId];
      // Guard: quantity_reserved must stay <= (total - sold - qty) after increment.
      const threshold = (lot.quantity_total || 0) - (lot.quantity_sold || 0) - qty;
      const res = await svc.entities.SalesLot.updateMany(
        { id: lotId, quantity_reserved: { $lte: threshold } },
        { $inc: { quantity_reserved: qty } }
      );
      if (!res || !res.updated) {
        // Race — rollback reservations already made and abort.
        for (const rid of reservedLots) {
          const rq = demandByLot[rid];
          await svc.entities.SalesLot.updateMany({ id: rid }, { $inc: { quantity_reserved: -rq } });
        }
        return Response.json({ error: `Lote "${lot.name}" esgotou enquanto você finalizava. Tente novamente.` }, { status: 409 });
      }
      reservedLots.push(lotId);
    }

    // Build cart lines for total calc.
    const typeIds = [...new Set(items.map((i: any) => i.ticket_type_id || lotById[i.lot_id].ticket_type_id))];
    const ticketTypes = await svc.entities.TicketType.filter({ id: { $in: typeIds }, event_id: eventId, is_deleted: false });
    const typeById: Record<string, any> = {};
    for (const t of ticketTypes) typeById[t.id] = t;

    const lines = items.map((it: any) => {
      const lot = lotById[it.lot_id];
      const typeId = it.ticket_type_id || lot.ticket_type_id;
      const ttype = typeById[typeId];
      return {
        lot_id: it.lot_id,
        ticket_type_id: typeId,
        ticket_type_name: ttype?.name || 'Ingresso',
        unit_price: lot.price,
        holder_name: it.holder_name,
        holder_email: it.holder_email,
        holder_phone: it.holder_phone,
      };
    });

    // Coupon validation.
    let coupon: any = null;
    if (couponCode) {
      const coupons = await svc.entities.Coupon.filter({ event_id: eventId, code: String(couponCode).toUpperCase().trim(), is_deleted: false });
      coupon = coupons[0] || null;
    }
    const totals = calculateCart(lines, coupon, now);
    if (couponCode && !totals.coupon_valid) {
      // release reservations
      for (const lotId of reservedLots) {
        await svc.entities.SalesLot.updateMany({ id: lotId }, { $inc: { quantity_reserved: -demandByLot[lotId] } });
      }
      return Response.json({ error: totals.coupon_message || 'Cupom inválido.' }, { status: 400 });
    }

    // Create Order — ou reusa o pedido pendente anterior (mesmo comprador/evento).
    const orderPayload = {
      buyer_user_id: user.id,
      buyer_person_id: buyerPersonId || '',
      buyer_name: user.full_name || '',
      buyer_email: user.email || '',
      event_id: eventId,
      status: 'pending',
      subtotal: totals.subtotal,
      discount: totals.discount,
      total: totals.total,
      coupon_id: coupon?.id || '',
      coupon_code: coupon?.code || '',
      currency: 'BRL',
      reserved_until: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min to pay
      fulfillment_status: 'pending',
    };
    let order;
    if (reusableOrder) {
      await svc.entities.Order.update(reusableOrder.id, orderPayload);
      order = { ...reusableOrder, ...orderPayload, id: reusableOrder.id };
    } else {
      order = await svc.entities.Order.create(orderPayload);
    }

    // Create OrderItems.
    const orderItems = [];
    for (const l of lines) {
      const oi = await svc.entities.OrderItem.create({
        order_id: order.id,
        event_id: eventId,
        lot_id: l.lot_id,
        ticket_type_id: l.ticket_type_id,
        ticket_type_name: l.ticket_type_name,
        holder_name: l.holder_name,
        holder_email: l.holder_email,
        holder_phone: l.holder_phone,
        unit_price: l.unit_price,
      });
      orderItems.push(oi);
    }

    // Free order (100% discount) — skip Stripe, fulfill immediately.
    if (totals.total <= 0) {
      const freePayment = await svc.entities.Payment.create({
        order_id: order.id,
        event_id: eventId,
        buyer_user_id: user.id,
        intent_id: `free_${order.id}`,
        amount: 0,
        amount_cents: 0,
        currency: 'BRL',
        status: 'pending',
        provider: 'free',
        payment_method: 'free',
        refunded_amount: 0,
        fulfillment_status: 'pending',
      });
      try {
        await fulfillOrder(svc, freePayment, order, orderItems);
      } catch (err: any) {
        console.error('[createPaymentIntent] free fulfillment error:', err?.message || err);
      }
      // Trail — compra gratuita registrada com comprador, carrinho, valores e IP.
      await writeAudit(svc, {
        action: 'create',
        entity_type: 'Order',
        entity_id: order.id,
        user_id: user.id,
        user_name: user.full_name || user.email || '',
        event_id: eventId,
        ip_address: clientIp,
        details: JSON.stringify({
          type: 'compra_iniciada',
          gratuito: true,
          payment_id: freePayment.id,
          intent_id: freePayment.intent_id,
          comprador: { id: user.id, nome: user.full_name || '', email: user.email || '' },
          itens: lines.map((l: any) => ({
            tipo: l.ticket_type_name,
            titular: l.holder_name,
            email: l.holder_email,
            lote: lotById[l.lot_id]?.name || l.lot_id,
            valor: l.unit_price,
          })),
          subtotal: totals.subtotal,
          desconto: totals.discount,
          cupom: coupon?.code || '',
          total: totals.total,
        }),
      });
      // P2 — o uso do cupom é contabilizado dentro do fulfillOrder (idempotente,
      // com marker no pedido) — não aqui na criação.
      try { await ensureCompanionInvites(base44, svc, orderItems); } catch {}
      return Response.json({
        free: true,
        order_id: order.id,
        payment_id: freePayment.id,
        total: totals.total,
        subtotal: totals.subtotal,
        discount: totals.discount,
      });
    }

    // Create Stripe PaymentIntent.
    const amountCents = toCents(totals.total);
    // Comissão da plataforma (destination charges): override do evento,
    // senão padrão global; 0 se nada configurado. Retida automaticamente
    // pelo Stripe antes do valor chegar ao organizador.
    let applicationFeeCents = 0;
    if (destinationAccountId) {
      let platformCommissionPercent = 0;
      try {
        const commissionSetting = (await svc.entities.PlatformSetting.filter({ key: 'commission' }))[0];
        platformCommissionPercent = Number(JSON.parse(commissionSetting?.value_json || '{}').default_commission_percent) || 0;
      } catch {}
      const commissionPercent = event.commission_percent != null ? Number(event.commission_percent) : platformCommissionPercent;
      const pct = Math.min(100, Math.max(0, commissionPercent || 0));
      applicationFeeCents = Math.min(Math.round(amountCents * pct / 100), amountCents);
    }
    let intent;
    try {
      // Chave de idempotência ÚNICA POR TENTATIVA (P3): o Stripe casheia a chave
      // por 24h — reusar pi_create_<orderId> devolve o intent antigo
      // (possivelmente cancelado) como se fosse novo e trava o re-checkout.
      // Revalida o intent retornado: morto ou com valor errado → cancela e
      // tenta de novo (nunca devolve client_secret de intent cancelado).
      for (let attempt = 0; attempt < 3; attempt++) {
        intent = await createPaymentIntent({
          amountCents,
          currency: 'BRL',
          orderId: order.id,
          eventId,
          destinationAccountId: destinationAccountId || undefined,
          applicationFeeCents,
          idempotencyKey: `pi_create_${order.id}_${Date.now()}_${attempt}`,
        });
        if (intent && intent.status !== 'canceled' && Number(intent.amount) === amountCents) break;
        console.error('[createPaymentIntent] intent inválido retornado (tentativa ' + (attempt + 1) + '):', intent?.status, intent?.amount);
        if (intent && intent.status !== 'canceled') {
          try { await cancelPaymentIntent(intent.id); } catch {}
        }
        intent = null;
      }
      if (!intent) throw new Error('Stripe devolveu um PaymentIntent inválido após as retentativas.');
    } catch (err: any) {
      // Rollback: release reservations + cancel order.
      for (const lotId of reservedLots) {
        await svc.entities.SalesLot.updateMany({ id: lotId }, { $inc: { quantity_reserved: -demandByLot[lotId] } });
      }
      await svc.entities.Order.update(order.id, { status: 'cancelled', error_reason: err?.message });
      console.error('[createPaymentIntent] Stripe error:', err?.message || err);
      return Response.json({ error: `Falha ao iniciar pagamento: ${err?.message || 'erro Stripe'}` }, { status: 502 });
    }

    // Create Payment record.
    const payment = await svc.entities.Payment.create({
      order_id: order.id,
      event_id: eventId,
      buyer_user_id: user.id,
      intent_id: intent.id,
      amount: totals.total,
      amount_cents: amountCents,
      currency: 'BRL',
      status: 'pending',
      provider: 'stripe',
      client_secret: intent.client_secret,
      refunded_amount: 0,
      fulfillment_status: 'pending',
      destination_account_id: destinationAccountId,
      application_fee_amount: applicationFeeCents ? applicationFeeCents / 100 : 0,
    });

    // Trail — compra com pagamento Stripe registrada com comprador, carrinho,
    // valores, identificador único da transação (intent_id) e IP do comprador.
    await writeAudit(svc, {
      action: 'create',
      entity_type: 'Order',
      entity_id: order.id,
      user_id: user.id,
      user_name: user.full_name || user.email || '',
      event_id: eventId,
      ip_address: clientIp,
      details: JSON.stringify({
        type: 'compra_iniciada',
        gratuito: false,
        payment_id: payment.id,
        intent_id: intent.id,
        destino_conta_stripe: destinationAccountId || '',
        comissao_plataforma: applicationFeeCents ? applicationFeeCents / 100 : 0,
        comprador: { id: user.id, nome: user.full_name || '', email: user.email || '' },
        itens: lines.map((l: any) => ({
          tipo: l.ticket_type_name,
          titular: l.holder_name,
          email: l.holder_email,
          lote: lotById[l.lot_id]?.name || l.lot_id,
          valor: l.unit_price,
        })),
        subtotal: totals.subtotal,
        desconto: totals.discount,
        cupom: coupon?.code || '',
        total: totals.total,
      }),
    });

    // P2 — o uso do cupom é contabilizado no fulfillment (pagamento confirmado,
    // dentro do fulfillOrder): checkouts abandonados não consomem cupom.

    return Response.json({
      client_secret: intent.client_secret,
      order_id: order.id,
      payment_id: payment.id,
      total: totals.total,
      subtotal: totals.subtotal,
      discount: totals.discount,
    });
  } catch (error: any) {
    console.error('[createPaymentIntent]', error?.message || error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
/**
 * Lote crítico de segurança/transação/privacidade — 2026-09-28 (r2).
 *
 * Cobertura permanente (cada teste reproduz a falha anterior e prova a correção):
 *   SEC-001  PersonDocument — escrita direta bloqueada para não-admin;
 *            managePersonDocument deriva person_id do autenticado e nunca
 *            transfere titularidade em update.
 *   SEC-002  expireStaleReservations — EXCLUSIVAMENTE admin autenticado:
 *            anônimo 401 (verificado NA BORDA PUBLICADA via fetch), não-admin
 *            403, admin permitido, execução repetida não expira pedido nem
 *            devolve reserva duas vezes. O mecanismo de credencial do
 *            scheduler foi REMOVIDO (o valor estava versionado no arquivo do
 *            workflow — comprometido); a execução agendada fica suspensa até
 *            mecanismo suportado pela plataforma (injeção de segredo pelo
 *            ambiente/scheduler ou autenticação nativa de workflow).
 *            NENHUM teste contém ou imprime credencial — por design.
 *   SEC-003  checkinTicket — claim atômico: scans concorrentes confirmam UMA
 *            entrada (1 auditoria); refund_pending/refunded nunca viram 'used'.
 *   SEC-004  requireActiveUser — conta ativa passa (AU-1); conta com
 *            account_status='deleted' e token AINDA VÁLIDO (login anterior à
 *            exclusão) recebe 403 em leitura protegida (getMyPerson) e escrita
 *            (saveMyPerson) — AU-2 marca/restaura a persona em runtime.
 *   INF-001  import_lookup — escopo estrito do evento autorizado (nenhum
 *            registro/e-mail/CPF de outro evento); não-gestão recebe 403.
 *   INF-002  getPartnerPersons — enumeração global de Persons ELIMINADA:
 *            SOMENTE vinculadas ao próprio parceiro; search é filtro local
 *            (termo < 3 chars retorna vazio — nunca relaxa o escopo);
 *            campos mínimos; parceiro alheio → 403. Conta excluída → 403
 *            (fixture pendente no TEST-CATALOG).
 *   FIN-001  createPaymentIntent — claim atômico ANTES de criar Order/OrderItem/
 *            PaymentIntent, por (comprador + evento) com locks SIMULTÂNEOS e
 *            INDEPENDENTES (r2: gate CAS no array Person.checkout_lock_events
 *            + registros CheckoutLock — o lock único escalar permitia reabrir
 *            a corrida alternando eventos A→B→A): duas requisições
 *            concorrentes → exatamente um checkout pagável e no máximo um
 *            PaymentIntent pendente; perdedora recebe 409 controlado; falha
 *            antes do Stripe libera lock e reservas; recheckout normal segue
 *            pelo reuso atômico do pedido pendente; checkouts em eventos
 *            DISTINTOS coexistem (CO-3/CO-4/CO-5).
 *   FIN-002  reserva atômica de uso de cupom no checkout: dois compradores
 *            disputando a ÚLTIMA utilização → um desconto, um 409; expiração
 *            devolve a utilização (CP-3).
 *   DAT-002  idempotência de estorno: repetição com solicitação pendente não
 *            cria segunda RefundRequest (RR-1); reconciler converge a
 *            pendência SEM stripe_refund_id em falha terminal ÚNICA, devolve
 *            o teto e destrava o ingresso — execução repetida é idempotente
 *            (RR-2). O caminho de SUCESSO do reconciler (refund confirmado no
 *            Stripe) foi provado ao vivo em sandbox com a mesma chave de
 *            idempotência (2026-09-28) — o runner de QA não guarda segredos
 *            Stripe, então RR-2 usa o caminho de falha determinística.
 *   PERF-001 paginação backend obrigatória em getEventOrders: total exato,
 *            limite, cursores e has_more; páginas sem duplicar nem omitir
 *            (PM-1); sem vínculo de gestão → 403 (PM-2). getSalesMetrics/
 *            getEventSalesSummary usam varredura completa paginada (scanAll)
 *            — sem limite silencioso 10000/20000.
 *   FIN-003  managePayouts — papel 'team' barrado em ações financeiras
 *            (startOnboarding/setReserve).
 *   DAT-001  Coupon.code único POR EVENTO de forma CONCORRENTE (claim atômico
 *            no registro do evento): corrida de criação → um sucesso + um 409
 *            + exatamente um cupom ativo; update concorrente para código
 *            existente → 409 sem corromper o cupom existente; mesmo código em
 *            eventos distintos permitido; legados duplicados apenas
 *            diagnosticados (nunca apagados automaticamente).
 *
 * Stripe: ambiente de TESTES/sandbox do app — os PaymentIntents pendentes
 * criados pelos testes FIN-001 são de teste; o cleanup encerra pedido/itens,
 * devolve reservas e marca o pagamento como expirado.
 *
 * Requer: E2E_BASE_URL + personas (env). Suíte pura de SDK (projeto
 * security-direct, grep @rls) — sem navegador.
 */
import process from 'node:process';
import { test, expect } from '@playwright/test';
import { createClient } from '@base44/sdk';

const APP_ID = process.env.BASE44_APP_ID || '6a2c618daec1758ff2122225';
const APP_URL = process.env.E2E_BASE_URL || 'https://share--evolve-summit.base44.app';

const PERSONAS = {
  admin: ['E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD'],
  manager: ['E2E_MANAGER_EMAIL', 'E2E_MANAGER_PASSWORD'],
  staff: ['E2E_STAFF_EMAIL', 'E2E_STAFF_PASSWORD'],
  participant: ['E2E_PARTICIPANT_EMAIL', 'E2E_PARTICIPANT_PASSWORD'],
  partner: ['E2E_PARTNER_EMAIL', 'E2E_PARTNER_PASSWORD'],
};

async function clientFor(role) {
  const [emailEnv, passEnv] = PERSONAS[role];
  const email = process.env[emailEnv];
  const password = process.env[passEnv];
  test.skip(!email || !password, `${role} credentials not configured (${emailEnv})`);
  const client = createClient({ appId: APP_ID, appBaseUrl: APP_URL, requiresAuth: true });
  await client.auth.loginViaEmailPassword(email, password);
  return client;
}

const errStatus = (e) => e?.response?.status || null;
const errMsg = (e) => String(e?.response?.data?.error || e?.message || '');

async function invokeSafe(client, fn, payload) {
  try {
    return { ok: true, data: await client.functions.invoke(fn, payload) };
  } catch (e) {
    return { ok: false, status: errStatus(e), message: errMsg(e) };
  }
}

test.describe('Hardening crítico — SEC-001 PersonDocument @security @rls @hardening', () => {
  test('PDW-1 usuário comum NÃO cria documento direto via SDK (escrita é admin-only)', async () => {
    const participant = await clientFor('participant');
    const me = await participant.auth.me();
    await expect(
      participant.entities.PersonDocument.create({
        person_id: me.person_id || '000000000000000000000000',
        country_code: 'BR',
        document_type: 'CPF',
        document_number: '12345678901',
      })
    ).rejects.toBeTruthy();
  });

  test('PDW-2 managePersonDocument deriva person_id do autenticado e titularidade é imutável', async () => {
    const participant = await clientFor('participant');
    const me = await participant.auth.me();
    test.skip(!me.person_id, 'participant persona sem person_id vinculada');

    // create com person_id de terceiro no corpo — o servidor deve ignorar e
    // vincular à própria Person.
    const created = await invokeSafe(participant, 'managePersonDocument', {
      operation: 'create',
      data: {
        person_id: '000000000000000000000000', // terceiro — nunca deve prevalecer
        country_code: 'BR',
        document_type: 'RG',
        document_number: `E2E-SEC1-${Date.now()}`,
        status: 'active',
      },
    });
    expect(created.ok, created.message).toBe(true);
    expect(created.data.document.person_id).toBe(me.person_id);

    // update tentando transferir person_id — o servidor deve descartar.
    const updated = await invokeSafe(participant, 'managePersonDocument', {
      operation: 'update',
      documentId: created.data.document.id,
      data: { person_id: '000000000000000000000000', document_type: 'CPF' },
    });
    expect(updated.ok, updated.message).toBe(true);
    expect(updated.data.document.person_id).toBe(me.person_id);

    // update DIRETO via SDK também bloqueado (RLS admin-only).
    await expect(
      participant.entities.PersonDocument.update(created.data.document.id, {
        person_id: '000000000000000000000000',
      })
    ).rejects.toBeTruthy();

    // cleanup
    await invokeSafe(participant, 'managePersonDocument', {
      operation: 'delete',
      documentId: created.data.document.id,
    });
  });

  test('PDW-3 usuário não lê documento de terceiro (leitura preservada por titular)', async () => {
    const participant = await clientFor('participant');
    const me = await participant.auth.me();
    const docs = await participant.entities.PersonDocument.filter({});
    for (const d of docs) expect(d.person_id).toBe(me.person_id);
  });
});

test.describe('Hardening crítico — INF-001 import_lookup @security @rls @hardening', () => {
  test('IL-1 manager recebe SOMENTE participantes do evento autorizado (nada cross-event)', async () => {
    const manager = await clientFor('manager');
    const me = await manager.auth.me();
    const memberships = await manager.entities.EventMembership.list();
    const mgrEvent = (memberships || []).find(
      (m) => m.user_id === me.id && (m.role === 'manager' || m.role === 'team') && m.is_active !== false
    );
    test.skip(!mgrEvent, 'manager persona sem membership manager/team semeada');

    const res = await invokeSafe(manager, 'getEventParticipants', {
      op: 'import_lookup',
      event_id: mgrEvent.event_id,
    });
    expect(res.ok, res.message).toBe(true);
    for (const p of res.data.participants || []) {
      expect(p.event_id).toBe(mgrEvent.event_id);
      // campos mínimos: nada além do indispensável à dedup
      expect(Object.keys(p).sort()).toEqual(['cpf', 'email', 'event_id', 'id', 'person_id'].sort());
    }
  });

  test('IL-2 usuário sem papel manager/team não executa import_lookup', async () => {
    const manager = await clientFor('manager');
    const me = await manager.auth.me();
    const memberships = await manager.entities.EventMembership.list();
    const mgrEvent = (memberships || []).find(
      (m) => m.user_id === me.id && (m.role === 'manager' || m.role === 'team') && m.is_active !== false
    );
    test.skip(!mgrEvent, 'manager persona sem membership manager/team semeada');

    const participant = await clientFor('participant');
    const res = await invokeSafe(participant, 'getEventParticipants', {
      op: 'import_lookup',
      event_id: mgrEvent.event_id,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });
});

test.describe('Hardening crítico — SEC-002 expireStaleReservations @security @rls @hardening', () => {
  test('SR-1 chamada anônima NA BORDA PUBLICADA é bloqueada (401/403) — nenhuma mutação financeira', async () => {
    const r = await fetch(`${APP_URL}/functions/expireStaleReservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect([401, 403]).toContain(r.status);
    const body = await r.json().catch(() => ({}));
    expect(body.ok).toBeUndefined(); // nunca executa
  });

  test('SR-2 usuário autenticado não-admin recebe 403', async () => {
    const manager = await clientFor('manager');
    const res = await invokeSafe(manager, 'expireStaleReservations', {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });

  test('SR-3 admin autenticado executa (permitido)', async () => {
    const admin = await clientFor('admin');
    const res = await invokeSafe(admin, 'expireStaleReservations', {});
    expect(res.ok, res.message).toBe(true);
    expect(res.data.ok).toBe(true);
  });

  test('SR-4 execução repetida não expira pedido nem devolve reserva duas vezes', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip(!events?.length, 'nenhum evento ativo para fixture de expiração');
    const eventId = events[0].id;
    const me = await admin.auth.me();

    // fixture: lote com 1 reserva viva + pedido pendente cuja reserva venceu há 1h.
    const lot = await admin.entities.SalesLot.create({
      event_id: eventId,
      ticket_type_id: '',
      name: `E2E-SR4-${Date.now()}`,
      price: 10,
      sale_start: new Date(Date.now() - 86400000).toISOString(),
      sale_end: new Date(Date.now() + 86400000).toISOString(),
      quantity_total: 5,
      quantity_reserved: 1,
      quantity_sold: 0,
      is_active: true,
    });
    const order = await admin.entities.Order.create({
      buyer_user_id: me.id,
      event_id: eventId,
      status: 'pending',
      total: 10,
      reserved_until: new Date(Date.now() - 3600000).toISOString(),
      fulfillment_status: 'pending',
    });
    const item = await admin.entities.OrderItem.create({
      order_id: order.id,
      event_id: eventId,
      lot_id: lot.id,
      ticket_type_id: '',
      ticket_type_name: 'E2E SR4',
      holder_name: 'E2E SR4',
      holder_email: `e2e-sr4-${Date.now()}@example.com`,
      holder_phone: '11999999999',
      unit_price: 10,
    });
    try {
      const r1 = await invokeSafe(admin, 'expireStaleReservations', {});
      expect(r1.ok, r1.message).toBe(true);
      const r2 = await invokeSafe(admin, 'expireStaleReservations', {});
      expect(r2.ok, r2.message).toBe(true);

      // pedido cancelado UMA vez; reserva devolvida EXATAMENTE uma vez
      // (segunda execução não devolve de novo — sem anti-oversell quebrado).
      const freshOrder = (await admin.entities.Order.filter({ id: order.id }))[0];
      expect(freshOrder.status).toBe('cancelled');
      const freshLot = (await admin.entities.SalesLot.filter({ id: lot.id }))[0];
      expect(freshLot.quantity_reserved).toBe(0);
      expect(freshLot.quantity_reserved).toBeGreaterThanOrEqual(0);
    } finally {
      await admin.entities.OrderItem.delete(item.id).catch(() => {});
      await admin.entities.Order.delete(order.id).catch(() => {});
      await admin.entities.SalesLot.delete(lot.id).catch(() => {});
    }
  });
});

test.describe('Hardening crítico — SEC-003 checkinTicket @security @rls @hardening', () => {
  test('CK-1 dois check-ins concorrentes confirmam UMA entrada e geram UMA auditoria', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip(!events?.length, 'nenhum evento ativo para fixture de ticket');
    const eventId = events[0].id;
    const code = `E2ESEC3${Date.now()}`;

    const ticket = await admin.entities.Ticket.create({
      event_id: eventId,
      ticket_type_id: '',
      holder_name: 'E2E SEC-003',
      holder_email: `e2e-sec3-${Date.now()}@example.com`,
      hash_code: code,
      status: 'issued',
    });
    try {
      const [r1, r2] = await Promise.allSettled([
        admin.functions.invoke('checkinTicket', { code }),
        admin.functions.invoke('checkinTicket', { code }),
      ]);
      const v1 = r1.status === 'fulfilled' ? r1.value : null;
      const v2 = r2.status === 'fulfilled' ? r2.value : null;
      const oks = [v1, v2].filter((v) => v?.ok === true).length;
      const alreadyUsed = [v1, v2].filter((v) => v?.ok === false && v?.status === 'used').length;
      expect(oks).toBe(1);
      expect(alreadyUsed).toBe(1);

      const fresh = (await admin.entities.Ticket.filter({ id: ticket.id }))[0];
      expect(fresh.status).toBe('used');

      const audit = await admin.entities.AuditLog.filter({
        entity_id: ticket.id,
        entity_type: 'Ticket',
      });
      expect(audit.filter((a) => String(a.details || '').includes('ticket_checkin')).length).toBe(1);
    } finally {
      await admin.entities.Ticket.delete(ticket.id).catch(() => {});
    }
  });

  test('CK-2 check-in NUNCA sobrescreve refund_pending nem aceita refunded', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip(!events?.length, 'nenhum evento ativo para fixture de ticket');
    const eventId = events[0].id;
    const code = `E2ESEC3R${Date.now()}`;

    const ticket = await admin.entities.Ticket.create({
      event_id: eventId,
      ticket_type_id: '',
      holder_name: 'E2E SEC-003 R',
      holder_email: `e2e-sec3r-${Date.now()}@example.com`,
      hash_code: code,
      status: 'issued',
    });
    try {
      // estorno em andamento (trava anti-corrida) — check-in bloqueado
      await admin.entities.Ticket.update(ticket.id, { status: 'refund_pending' });
      const blocked = await invokeSafe(admin, 'checkinTicket', { code });
      expect(blocked.ok).toBe(false);
      expect(blocked.data ? blocked.data.status : blocked.status).toBe('refund_pending');
      let fresh = (await admin.entities.Ticket.filter({ id: ticket.id }))[0];
      expect(fresh.status).toBe('refund_pending'); // não virou 'used'

      // estornado — entrada bloqueada
      await admin.entities.Ticket.update(ticket.id, { status: 'refunded' });
      const blocked2 = await invokeSafe(admin, 'checkinTicket', { code });
      expect(blocked2.ok).toBe(false);
      fresh = (await admin.entities.Ticket.filter({ id: ticket.id }))[0];
      expect(fresh.status).toBe('refunded');
    } finally {
      await admin.entities.Ticket.delete(ticket.id).catch(() => {});
    }
  });
});

test.describe('Hardening crítico — SEC-004 requireActiveUser @security @rls @hardening', () => {
  test('AU-1 conta ativa continua funcionando (controle positivo do guard)', async () => {
    const participant = await clientFor('participant');
    const res = await invokeSafe(participant, 'getMyPerson', {});
    expect(res.ok, res.message).toBe(true);
  });
});

test.describe('Hardening crítico — INF-002 getPartnerPersons @security @rls @hardening', () => {
  test('PP-1 SOMENTE Persons vinculadas ao parceiro — sem enumeração global, campos mínimos, busca é filtro local', async () => {
    const partner = await clientFor('partner');
    const res0 = await invokeSafe(partner, 'getManagedPartners', {});
    test.skip(!res0.ok || !res0.data?.partners?.length, 'partner persona sem parceiro gerido semeado');
    const partnerId = res0.data.partners[0].id;

    const base = await invokeSafe(partner, 'getPartnerPersons', { partnerId });
    expect(base.ok, base.message).toBe(true);
    for (const p of base.data.persons || []) {
      expect(Object.keys(p).sort()).toEqual(['contact_email', 'full_name', 'id', 'is_active'].sort());
    }
    const baseline = base.data.persons || [];

    // termo que não casa NENHUMA vinculada → vazio: prova que não há fallback
    // para o catálogo global (o código antigo listava Person globais aqui).
    const search = await invokeSafe(partner, 'getPartnerPersons', {
      partnerId,
      search: `zzqx-${Date.now()}`,
    });
    expect(search.ok, search.message).toBe(true);
    expect(search.data.persons).toEqual([]);

    // termo curto (< 3 chars) NÃO relaxa o escopo — lista vazia, sem busca.
    const short = await invokeSafe(partner, 'getPartnerPersons', { partnerId, search: 'ab' });
    expect(short.ok, short.message).toBe(true);
    expect(short.data.persons).toEqual([]);

    // busca válida retorna SUBCONJUNTO das vinculadas — nunca pessoa de fora.
    if (baseline.length > 0) {
      const probe = String(baseline[0].full_name || '').slice(0, 4);
      const hit = await invokeSafe(partner, 'getPartnerPersons', { partnerId, search: probe });
      expect(hit.ok, hit.message).toBe(true);
      for (const p of hit.data.persons || []) {
        expect(baseline.some((b) => b.id === p.id)).toBe(true);
      }
    }
  });

  test('PP-2 partner manager não consulta Persons de parceiro alheio (403)', async () => {
    const partner = await clientFor('partner');
    const res0 = await invokeSafe(partner, 'getManagedPartners', {});
    test.skip(!res0.ok || !res0.data?.partners?.length, 'partner persona sem parceiro gerido semeado');
    const ownIds = new Set(res0.data.partners.map((p) => p.id));

    const pub = await invokeSafe(partner, 'getPublicPartners', {});
    const other = (pub.data?.partners || pub.data || []).find?.((p) => !ownIds.has(p.id));
    test.skip(!other, 'nenhum parceiro alheio disponível para o teste negativo');

    const res = await invokeSafe(partner, 'getPartnerPersons', { partnerId: other.id });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
  });
});

test.describe('Hardening crítico — FIN-001 exclusividade atômica de checkout @security @hardening', () => {
  async function findPurchasableLot(admin, eventId, minSeats) {
    const lots = await admin.entities.SalesLot.filter({ event_id: eventId, is_deleted: false, is_active: true });
    const nowIso = new Date().toISOString();
    return lots.find(
      (l) =>
        (l.quantity_total || 0) - (l.quantity_reserved || 0) - (l.quantity_sold || 0) >= minSeats &&
        (!l.sale_start || new Date(l.sale_start) < new Date(nowIso)) &&
        (!l.sale_end || new Date(l.sale_end) > new Date(nowIso))
    );
  }

  // FIN-001 r2 — libera o lock multi-evento do comprador para o evento
  // informado: gate ($pull escopado) + registro CheckoutLock encerrado.
  // Idempotente; nunca toca locks de outros eventos.
  async function releaseEventLock(admin, buyerPersonId, eventId) {
    if (!buyerPersonId || !eventId) return;
    await admin.entities.Person.updateMany(
      { id: buyerPersonId, checkout_lock_events: eventId },
      { $pull: { checkout_lock_events: eventId } }
    ).catch(() => {});
    await admin.entities.CheckoutLock.updateMany(
      { person_id: buyerPersonId, event_id: eventId, status: 'active' },
      { $set: { status: 'released', released_reason: 'e2e-cleanup' } }
    ).catch(() => {});
  }

  async function cleanupPendingOrder(admin, orderId, buyerPersonId, eventId) {
    try {
      const items = await admin.entities.OrderItem.filter({ order_id: orderId, is_deleted: false });
      for (const it of items) {
        await admin.entities.SalesLot.updateMany(
          { id: it.lot_id, quantity_reserved: { $gte: 1 } },
          { $inc: { quantity_reserved: -1 } }
        ).catch(() => {});
        await admin.entities.OrderItem.update(it.id, { is_deleted: true }).catch(() => {});
      }
      const payments = await admin.entities.Payment.filter({ order_id: orderId });
      for (const p of payments) {
        await admin.entities.Payment.updateMany(
          { id: p.id, status: 'pending' },
          { $set: { status: 'expired', error_reason: 'E2E FIN-001 cleanup' } }
        ).catch(() => {});
      }
      await admin.entities.Order.update(orderId, { status: 'cancelled', error_reason: 'E2E FIN-001 cleanup' }).catch(() => {});
      await releaseEventLock(admin, buyerPersonId, eventId);
    } catch {}
  }

  test('CO-1 duas requisições concorrentes do mesmo usuário/evento → exatamente um checkout pagável, no máximo um PaymentIntent', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip(!events?.length, 'nenhum evento ativo para fixture de checkout');
    const eventId = events[0].id;
    const lot = await findPurchasableLot(admin, eventId, 1);
    test.skip(!lot, 'nenhum lote com estoque e janela de venda aberta');

    // Duas SESSÕES do MESMO usuário (duas abas/dispositivos).
    const s1 = await clientFor('participant');
    const s2 = await clientFor('participant');
    const me1 = await s1.auth.me();
    const payload = {
      eventId,
      items: [{
        lot_id: lot.id,
        ticket_type_id: lot.ticket_type_id,
        holder_name: 'E2E FIN-001',
        holder_email: `e2e-fin1-${Date.now()}@example.com`,
        holder_phone: '11999999999',
      }],
    };

    const [r1, r2] = await Promise.allSettled([
      invokeSafe(s1, 'createPaymentIntent', payload),
      invokeSafe(s2, 'createPaymentIntent', payload),
    ]);
    const v1 = r1.status === 'fulfilled' ? r1.value : null;
    const v2 = r2.status === 'fulfilled' ? r2.value : null;
    const winners = [v1, v2].filter((v) => v?.ok);
    const losers = [v1, v2].filter((v) => v && v.ok === false);

    // Exatamente um checkout pagável; perdedora recebe conflito controlado.
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].status).toBe(409);

    // No máximo um PaymentIntent VIVO para o pedido vencedor (a perdedora não
    // chegou ao Stripe — nem Order, nem PaymentIntent).
    const winner = winners[0];
    const orderId = winner.data.order_id;
    const payments = await admin.entities.Payment.filter({ order_id: orderId });
    expect(payments.filter((p) => p.status === 'pending').length).toBeLessThanOrEqual(1);

    await cleanupPendingOrder(admin, orderId, me1.person_id, eventId);
  });

  test('CO-2 recheckout normal continua funcionando (reuso atômico do pedido pendente)', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip(!events?.length, 'nenhum evento ativo para fixture de checkout');
    const eventId = events[0].id;
    const lot = await findPurchasableLot(admin, eventId, 1);
    test.skip(!lot, 'nenhum lote com estoque e janela de venda aberta');

    const s1 = await clientFor('participant');
    const me1 = await s1.auth.me();
    const base = { lot_id: lot.id, ticket_type_id: lot.ticket_type_id, holder_name: 'E2E FIN-001 R', holder_phone: '11999999999' };
    const first = await invokeSafe(s1, 'createPaymentIntent', {
      eventId,
      items: [{ ...base, holder_email: `e2e-fin1r-a-${Date.now()}@example.com` }],
    });
    expect(first.ok, first.message).toBe(true);

    // Segundo checkout do MESMO usuário/evento: lock vivo aponta para o
    // pedido → reuso atômico (não 409 de lock, não segundo pedido pagável).
    const second = await invokeSafe(s1, 'createPaymentIntent', {
      eventId,
      items: [{ ...base, holder_email: `e2e-fin1r-b-${Date.now()}@example.com` }],
    });
    expect(second.ok, second.message).toBe(true);
    expect(second.data.order_id).toBe(first.data.order_id);

    await cleanupPendingOrder(admin, first.data.order_id, me1.person_id, eventId);
  });
});

test.describe('Hardening crítico — FIN-001 r2 locks independentes por comprador+evento @security @hardening', () => {
  async function findPurchasableLot(admin, eventId, minSeats) {
    const lots = await admin.entities.SalesLot.filter({ event_id: eventId, is_deleted: false, is_active: true });
    const nowIso = new Date().toISOString();
    return lots.find(
      (l) =>
        (l.quantity_total || 0) - (l.quantity_reserved || 0) - (l.quantity_sold || 0) >= minSeats &&
        (!l.sale_start || new Date(l.sale_start) < new Date(nowIso)) &&
        (!l.sale_end || new Date(l.sale_end) > new Date(nowIso))
    );
  }

  async function cleanupPendingOrder(admin, orderId, buyerPersonId, eventId) {
    try {
      const items = await admin.entities.OrderItem.filter({ order_id: orderId, is_deleted: false });
      for (const it of items) {
        await admin.entities.SalesLot.updateMany(
          { id: it.lot_id, quantity_reserved: { $gte: 1 } },
          { $inc: { quantity_reserved: -1 } }
        ).catch(() => {});
        await admin.entities.OrderItem.update(it.id, { is_deleted: true }).catch(() => {});
      }
      const payments = await admin.entities.Payment.filter({ order_id: orderId });
      for (const p of payments) {
        await admin.entities.Payment.updateMany(
          { id: p.id, status: 'pending' },
          { $set: { status: 'expired', error_reason: 'E2E FIN-001 r2 cleanup' } }
        ).catch(() => {});
      }
      await admin.entities.Order.update(orderId, { status: 'cancelled', error_reason: 'E2E FIN-001 r2 cleanup' }).catch(() => {});
      if (buyerPersonId && eventId) {
        await admin.entities.Person.updateMany(
          { id: buyerPersonId, checkout_lock_events: eventId },
          { $pull: { checkout_lock_events: eventId } }
        ).catch(() => {});
        await admin.entities.CheckoutLock.updateMany(
          { person_id: buyerPersonId, event_id: eventId, status: 'active' },
          { $set: { status: 'released', released_reason: 'e2e-cleanup' } }
        ).catch(() => {});
      }
    } catch {}
  }

  test('CO-3 checkouts SIMULTÂNEOS em eventos DISTINTOS coexistem — locks A e B independentes', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip((events?.length || 0) < 2, 'requer 2+ eventos ativos');
    const evts = [];
    for (const ev of events.slice(0, 2)) {
      const lot = await findPurchasableLot(admin, ev.id, 1);
      test.skip(!lot, 'sem lote comprável nos eventos ativos');
      evts.push({ eventId: ev.id, lot });
    }

    const s1 = await clientFor('participant');
    const s2 = await clientFor('participant');
    const me1 = await s1.auth.me();
    const ts = Date.now();
    const mk = (e, suffix) => ({
      eventId: e.eventId,
      items: [{
        lot_id: e.lot.id,
        ticket_type_id: e.lot.ticket_type_id,
        holder_name: 'E2E FIN-001 AB',
        holder_email: `e2e-fin1-ab-${ts}-${suffix}@example.com`,
        holder_phone: '11999999999',
      }],
    });

    const [rA, rB] = await Promise.allSettled([
      invokeSafe(s1, 'createPaymentIntent', mk(evts[0], 'a')),
      invokeSafe(s2, 'createPaymentIntent', mk(evts[1], 'b')),
    ]);
    const vA = rA.status === 'fulfilled' ? rA.value : null;
    const vB = rB.status === 'fulfilled' ? rB.value : null;
    expect(vA?.ok, vA?.message).toBe(true);
    expect(vB?.ok, vB?.message).toBe(true);

    // locks ativos INDEPENDENTES no mesmo comprador (um por evento)
    const locks = await admin.entities.CheckoutLock.filter({ person_id: me1.person_id, status: 'active', is_deleted: false });
    expect(locks.filter((l) => l.event_id === evts[0].eventId).length).toBe(1);
    expect(locks.filter((l) => l.event_id === evts[1].eventId).length).toBe(1);

    await cleanupPendingOrder(admin, vA.data.order_id, me1.person_id, evts[0].eventId);
    await cleanupPendingOrder(admin, vB.data.order_id, me1.person_id, evts[1].eventId);
  });

  test('CO-4 com A e B pendentes, corrida por A dá UM reuso e UM 409; lock de B intacto', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip((events?.length || 0) < 2, 'requer 2+ eventos ativos');
    const evts = [];
    for (const ev of events.slice(0, 2)) {
      const lot = await findPurchasableLot(admin, ev.id, 2);
      test.skip(!lot, 'sem lote com 2+ lugares nos eventos ativos');
      evts.push({ eventId: ev.id, lot });
    }

    const s1 = await clientFor('participant');
    const s2 = await clientFor('participant');
    const me1 = await s1.auth.me();
    const ts = Date.now();
    const mk = (e, suffix) => ({
      eventId: e.eventId,
      items: [{
        lot_id: e.lot.id,
        ticket_type_id: e.lot.ticket_type_id,
        holder_name: 'E2E FIN-001 CO4',
        holder_email: `e2e-co4-${ts}-${suffix}@example.com`,
        holder_phone: '11999999999',
      }],
    });

    const firstA = await invokeSafe(s1, 'createPaymentIntent', mk(evts[0], 'a1'));
    expect(firstA.ok, firstA.message).toBe(true);
    const firstB = await invokeSafe(s1, 'createPaymentIntent', mk(evts[1], 'b1'));
    expect(firstB.ok, firstB.message).toBe(true);

    try {
      // corrida por A: lock vivo de A com pedido apontado → exatamente um
      // reuso (mesmo order_id) e um 409 — nunca dois pedidos pagáveis.
      const [r1, r2] = await Promise.allSettled([
        invokeSafe(s1, 'createPaymentIntent', mk(evts[0], 'a2')),
        invokeSafe(s2, 'createPaymentIntent', mk(evts[0], 'a3')),
      ]);
      const v1 = r1.status === 'fulfilled' ? r1.value : null;
      const v2 = r2.status === 'fulfilled' ? r2.value : null;
      const winners = [v1, v2].filter((v) => v?.ok);
      const losers = [v1, v2].filter((v) => v && v.ok === false);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      expect(losers[0].status).toBe(409);
      expect(winners[0].data.order_id).toBe(firstA.data.order_id);

      // lock de B segue ATIVO e aponta para o pedido B (não foi tocado)
      const lockB = (await admin.entities.CheckoutLock.filter({
        person_id: me1.person_id, event_id: evts[1].eventId, status: 'active', is_deleted: false,
      }))[0];
      expect(lockB).toBeTruthy();
      expect(lockB.order_id).toBe(firstB.data.order_id);
    } finally {
      await cleanupPendingOrder(admin, firstA.data.order_id, me1.person_id, evts[0].eventId);
      await cleanupPendingOrder(admin, firstB.data.order_id, me1.person_id, evts[1].eventId);
    }
  });

  test('CO-5 expiração de A libera SOMENTE A — novo checkout em A passa; B segue reusando o pedido pendente', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip((events?.length || 0) < 2, 'requer 2+ eventos ativos');
    const evts = [];
    for (const ev of events.slice(0, 2)) {
      const lot = await findPurchasableLot(admin, ev.id, 2);
      test.skip(!lot, 'sem lote com 2+ lugares nos eventos ativos');
      evts.push({ eventId: ev.id, lot });
    }

    const s1 = await clientFor('participant');
    const me1 = await s1.auth.me();
    const ts = Date.now();
    const mk = (e, suffix) => ({
      eventId: e.eventId,
      items: [{
        lot_id: e.lot.id,
        ticket_type_id: e.lot.ticket_type_id,
        holder_name: 'E2E FIN-001 CO5',
        holder_email: `e2e-co5-${ts}-${suffix}@example.com`,
        holder_phone: '11999999999',
      }],
    });

    const firstA = await invokeSafe(s1, 'createPaymentIntent', mk(evts[0], 'a1'));
    expect(firstA.ok, firstA.message).toBe(true);
    const firstB = await invokeSafe(s1, 'createPaymentIntent', mk(evts[1], 'b1'));
    expect(firstB.ok, firstB.message).toBe(true);

    try {
      // simula vencimento de A: reserva do pedido + TTL do lock
      await admin.entities.Order.updateMany(
        { id: firstA.data.order_id },
        { $set: { reserved_until: new Date(Date.now() - 3600000).toISOString() } }
      );
      const lockA = (await admin.entities.CheckoutLock.filter({
        person_id: me1.person_id, event_id: evts[0].eventId, status: 'active', is_deleted: false,
      }))[0];
      expect(lockA).toBeTruthy();
      await admin.entities.CheckoutLock.updateMany(
        { id: lockA.id },
        { $set: { expires_at: new Date(Date.now() - 3600000).toISOString() } }
      );

      const exp = await invokeSafe(admin, 'expireStaleReservations', {});
      expect(exp.ok, exp.message).toBe(true);

      const freshA = (await admin.entities.Order.filter({ id: firstA.data.order_id }))[0];
      expect(freshA.status).toBe('cancelled');

      // lock de A liberado: novo checkout em A é permitido (novo pedido)
      const redo = await invokeSafe(s1, 'createPaymentIntent', mk(evts[0], 'a2'));
      expect(redo.ok, redo.message).toBe(true);
      expect(redo.data.order_id).not.toBe(firstA.data.order_id);

      // lock de B INTACTO: checkout em B reusa o pedido pendente de B
      const redoB = await invokeSafe(s1, 'createPaymentIntent', mk(evts[1], 'b2'));
      expect(redoB.ok, redoB.message).toBe(true);
      expect(redoB.data.order_id).toBe(firstB.data.order_id);

      await cleanupPendingOrder(admin, redo.data.order_id, me1.person_id, evts[0].eventId);
    } finally {
      await cleanupPendingOrder(admin, firstB.data.order_id, me1.person_id, evts[1].eventId);
    }
  });
});

test.describe('Hardening crítico — FIN-003 ações financeiras do papel team @security @rls @hardening', () => {
  test('PO-1 team recebe 403 em startOnboarding e setReserve (leitura permanece)', async () => {
    const staff = await clientFor('staff');
    const me = await staff.auth.me();
    const memberships = await staff.entities.EventMembership.list();
    const teamEvent = (memberships || []).find(
      (m) => m.user_id === me.id && m.role === 'team' && m.is_active !== false
    );
    test.skip(!teamEvent, 'staff persona sem membership team semeada');

    const onb = await invokeSafe(staff, 'managePayouts', {
      action: 'startOnboarding',
      eventId: teamEvent.event_id,
    });
    expect(onb.ok).toBe(false);
    expect(onb.status).toBe(403);
    expect(onb.message).toContain('financeiras');

    const res = await invokeSafe(staff, 'managePayouts', {
      action: 'setReserve',
      eventId: teamEvent.event_id,
      amount: 1,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.message).toContain('financeiras');

    // leitura estritamente necessária permanece liberada para team
    const read = await invokeSafe(staff, 'managePayouts', {
      action: 'getEventPayout',
      eventId: teamEvent.event_id,
    });
    expect(read.ok, read.message).toBe(true);
  });
});

test.describe('Hardening crítico — DAT-001 unicidade concorrente de cupom por evento @security @rls @hardening', () => {
  test('CP-1 criar cupom duplicado no mesmo evento falha; outro evento permite; update para código existente falha', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip((events?.length || 0) < 1, 'sem evento ativo para fixture de cupom');
    const eventId = events[0].id;

    const code = `E2EDUP${Date.now().toString(36).toUpperCase()}`;
    const base = { discount_type: 'percent', value: 10, max_uses: 5 };

    const c1 = await invokeSafe(admin, 'manageCommerce', {
      action: 'create', entityName: 'Coupon', eventId,
      data: { code, ...base },
    });
    expect(c1.ok, c1.message).toBe(true);
    const couponId = c1.data.record.id;

    try {
      // mesmo código no MESMO evento → 409
      const dup = await invokeSafe(admin, 'manageCommerce', {
        action: 'create', entityName: 'Coupon', eventId,
        data: { code, ...base },
      });
      expect(dup.ok).toBe(false);
      expect(dup.status).toBe(409);

      // mesmo código em OUTRO evento → permitido
      if (events.length > 1) {
        const other = await invokeSafe(admin, 'manageCommerce', {
          action: 'create', entityName: 'Coupon', eventId: events[1].id,
          data: { code, ...base },
        });
        expect(other.ok, other.message).toBe(true);
        await invokeSafe(admin, 'manageCommerce', {
          action: 'delete', entityName: 'Coupon', eventId: events[1].id, id: other.data.record.id,
        });
      }

      // update para código já existente no mesmo evento → 409
      const code2 = `E2EDUPB${Date.now().toString(36).toUpperCase()}`;
      const c2 = await invokeSafe(admin, 'manageCommerce', {
        action: 'create', entityName: 'Coupon', eventId,
        data: { code: code2, ...base },
      });
      expect(c2.ok, c2.message).toBe(true);
      const upd = await invokeSafe(admin, 'manageCommerce', {
        action: 'update', entityName: 'Coupon', eventId, id: couponId,
        data: { code: code2 },
      });
      expect(upd.ok).toBe(false);
      expect(upd.status).toBe(409);
      await invokeSafe(admin, 'manageCommerce', {
        action: 'delete', entityName: 'Coupon', eventId, id: c2.data.record.id,
      });

      // diagnóstico de legados: list sinaliza grupos duplicados sem apagar
      const lst = await invokeSafe(admin, 'manageCommerce', {
        action: 'list', entityName: 'Coupon', eventId,
      });
      expect(lst.ok, lst.message).toBe(true);
      expect(Array.isArray(lst.data.duplicate_codes)).toBe(true);
    } finally {
      await invokeSafe(admin, 'manageCommerce', {
        action: 'delete', entityName: 'Coupon', eventId, id: couponId,
      });
    }
  });

  test('CP-2 duas criações SIMULTÂNEAS do mesmo código/evento → um sucesso, um 409, exatamente um cupom ativo', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip((events?.length || 0) < 1, 'sem evento ativo para fixture de cupom');
    const eventId = events[0].id;

    const code = `E2ERACE${Date.now().toString(36).toUpperCase()}`;
    const base = { discount_type: 'percent', value: 10, max_uses: 5 };

    // Duas sessões admin disparando o MESMO código em corrida real.
    const a = await clientFor('admin');
    const b = await clientFor('admin');
    const [r1, r2] = await Promise.allSettled([
      invokeSafe(a, 'manageCommerce', { action: 'create', entityName: 'Coupon', eventId, data: { code, ...base } }),
      invokeSafe(b, 'manageCommerce', { action: 'create', entityName: 'Coupon', eventId, data: { code, ...base } }),
    ]);
    const v1 = r1.status === 'fulfilled' ? r1.value : null;
    const v2 = r2.status === 'fulfilled' ? r2.value : null;
    const winners = [v1, v2].filter((v) => v?.ok);
    const losers = [v1, v2].filter((v) => v && v.ok === false);

    // Um sucesso, um 409 — o vencedor JAMAIS é apagado pela perdedora.
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(losers[0].status).toBe(409);

    const winner = winners[0];
    const active = await admin.entities.Coupon.filter({ event_id: eventId, code, is_deleted: false });
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(winner.data.record.id);

    // cleanup: delete devolve o código ao registro; nenhum ativo permanece.
    await invokeSafe(admin, 'manageCommerce', {
      action: 'delete', entityName: 'Coupon', eventId, id: winner.data.record.id,
    });
    const stillActive = await admin.entities.Coupon.filter({ event_id: eventId, code, is_deleted: false });
    expect(stillActive.length).toBe(0);
  });
});

test.describe('Hardening crítico — SEC-004 conta excluída com token válido @security @rls @hardening', () => {
  test('AU-2 account_status=deleted + token pré-exclusão → 403 em leitura protegida e escrita', async () => {
    const admin = await clientFor('admin');
    const email = process.env.E2E_PARTICIPANT_EMAIL;
    test.skip(!email, 'E2E_PARTICIPANT_EMAIL not configured');

    // Login ANTES da exclusão → token válido nas mãos da persona.
    const participant = await clientFor('participant');
    const users = await admin.entities.User.filter({ email });
    test.skip(!users?.length, 'persona participante não encontrada no app de teste');
    const u = users[0];
    const prevStatus = u.account_status && u.account_status !== '' ? u.account_status : 'active';
    const restoreStatus = prevStatus === 'deleted' ? 'active' : prevStatus;

    try {
      await admin.entities.User.update(u.id, { account_status: 'deleted' });

      const read = await invokeSafe(participant, 'getMyPerson', {});
      expect(read.ok).toBe(false);
      expect(read.status).toBe(403);
      expect(read.message).toContain('excluída');

      const write = await invokeSafe(participant, 'saveMyPerson', { data: { bio: 'E2E SEC-004' } });
      expect(write.ok).toBe(false);
      expect(write.status).toBe(403);
    } finally {
      await admin.entities.User.update(u.id, { account_status: restoreStatus }).catch(() => {});
    }

    // pós-restauração a persona volta a funcionar (sem quebra permanente)
    const after = await invokeSafe(participant, 'getMyPerson', {});
    expect(after.ok, after.message).toBe(true);
  });
});

test.describe('Hardening crítico — FIN-002 última utilização de cupom em corrida @security @hardening', () => {
  async function findPurchasableLot(admin, eventId, minSeats) {
    const lots = await admin.entities.SalesLot.filter({ event_id: eventId, is_deleted: false, is_active: true });
    const nowIso = new Date().toISOString();
    return lots.find(
      (l) =>
        (l.quantity_total || 0) - (l.quantity_reserved || 0) - (l.quantity_sold || 0) >= minSeats &&
        (!l.sale_start || new Date(l.sale_start) < new Date(nowIso)) &&
        (!l.sale_end || new Date(l.sale_end) > new Date(nowIso))
    );
  }

  async function cleanupPendingOrder(admin, orderId, buyerPersonId, eventId) {
    try {
      const items = await admin.entities.OrderItem.filter({ order_id: orderId, is_deleted: false });
      for (const it of items) {
        await admin.entities.SalesLot.updateMany(
          { id: it.lot_id, quantity_reserved: { $gte: 1 } },
          { $inc: { quantity_reserved: -1 } }
        ).catch(() => {});
        await admin.entities.OrderItem.update(it.id, { is_deleted: true }).catch(() => {});
      }
      const payments = await admin.entities.Payment.filter({ order_id: orderId });
      for (const p of payments) {
        await admin.entities.Payment.updateMany(
          { id: p.id, status: 'pending' },
          { $set: { status: 'expired', error_reason: 'E2E FIN-002 cleanup' } }
        ).catch(() => {});
      }
      await admin.entities.Order.update(orderId, { status: 'cancelled', error_reason: 'E2E FIN-002 cleanup' }).catch(() => {});
      if (buyerPersonId && eventId) {
        await admin.entities.Person.updateMany(
          { id: buyerPersonId, checkout_lock_events: eventId },
          { $pull: { checkout_lock_events: eventId } }
        ).catch(() => {});
        await admin.entities.CheckoutLock.updateMany(
          { person_id: buyerPersonId, event_id: eventId, status: 'active' },
          { $set: { status: 'released', released_reason: 'e2e-cleanup' } }
        ).catch(() => {});
      }
    } catch {}
  }

  test('CP-3 dois compradores disputam a ÚLTIMA utilização → um desconto, um 409; expiração devolve o uso', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip(!events?.length, 'nenhum evento ativo');
    const eventId = events[0].id;
    const lot = await findPurchasableLot(admin, eventId, 2);
    test.skip(!lot, 'sem lote com 2+ lugares');

    // cupom com EXATAMENTE uma utilização restante
    const code = `E2EFIN2${Date.now().toString(36).toUpperCase()}`;
    const c = await invokeSafe(admin, 'manageCommerce', {
      action: 'create', entityName: 'Coupon', eventId,
      data: { code, discount_type: 'percent', value: 10, max_uses: 1 },
    });
    expect(c.ok, c.message).toBe(true);

    const s1 = await clientFor('participant');
    const s2 = await clientFor('staff');
    const me1 = await s1.auth.me();
    const me2 = await s2.auth.me();
    const ts = Date.now();
    const mk = (email) => ({
      eventId,
      couponCode: code,
      items: [{
        lot_id: lot.id,
        ticket_type_id: lot.ticket_type_id,
        holder_name: 'E2E FIN-002',
        holder_email: email,
        holder_phone: '11999999999',
      }],
    });

    try {
      const [r1, r2] = await Promise.allSettled([
        invokeSafe(s1, 'createPaymentIntent', mk(`e2e-fin2-a-${ts}@example.com`)),
        invokeSafe(s2, 'createPaymentIntent', mk(`e2e-fin2-b-${ts}@example.com`)),
      ]);
      const v1 = r1.status === 'fulfilled' ? r1.value : null;
      const v2 = r2.status === 'fulfilled' ? r2.value : null;
      const winners = [v1, v2].filter((v) => v?.ok);
      const losers = [v1, v2].filter((v) => v && v.ok === false);

      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      expect(losers[0].status).toBe(409);
      expect(Number(winners[0].data.discount)).toBeGreaterThan(0);

      const sN = winners[0] === v1 ? s1 : s2;
      const meN = winners[0] === v1 ? me1 : me2;
      const winnerOrder = winners[0].data.order_id;

      // uso reservado: uses_count conta a reserva atômica do vencedor
      const couponMid = (await admin.entities.Coupon.filter({ id: c.data.record.id }))[0];
      expect(Number(couponMid.uses_count || 0)).toBe(1);

      // expiração do pedido vencedor devolve a utilização
      await admin.entities.Order.updateMany(
        { id: winnerOrder },
        { $set: { reserved_until: new Date(Date.now() - 3600000).toISOString() } }
      );
      const exp = await invokeSafe(admin, 'expireStaleReservations', {});
      expect(exp.ok, exp.message).toBe(true);

      const couponFresh = (await admin.entities.Coupon.filter({ id: c.data.record.id }))[0];
      expect(Number(couponFresh.uses_count || 0)).toBe(0);

      // novo checkout com o mesmo cupom volta a receber o desconto
      const retry = await invokeSafe(sN, 'createPaymentIntent', mk(`e2e-fin2-c-${ts}@example.com`));
      expect(retry.ok, retry.message).toBe(true);
      expect(Number(retry.data.discount)).toBeGreaterThan(0);

      await cleanupPendingOrder(admin, retry.data.order_id, meN.person_id, eventId);
    } finally {
      await invokeSafe(admin, 'manageCommerce', {
        action: 'delete', entityName: 'Coupon', eventId, id: c.data.record.id,
      });
    }
  });
});

test.describe('Hardening crítico — DAT-002 idempotência de estorno @security @hardening', () => {
  test('RR-1 solicitação de estorno PENDENTE não gera segunda RefundRequest (repetição → rejeição)', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip(!events?.length, 'nenhum evento ativo');
    const eventId = events[0].id;
    const me = await admin.auth.me();

    const order = await admin.entities.Order.create({
      buyer_user_id: me.id, event_id: eventId, status: 'paid', total: 100,
      subtotal: 100, discount: 0, fulfillment_status: 'fulfilled',
    });
    const payment = await admin.entities.Payment.create({
      order_id: order.id, event_id: eventId, buyer_user_id: me.id,
      intent_id: `e2e_rr1_${Date.now()}`, amount: 100, amount_cents: 10000,
      currency: 'BRL', status: 'succeeded', provider: 'stripe', payment_method: 'card',
      refunded_amount: 40, fulfillment_status: 'fulfilled',
    });
    const pending = await admin.entities.RefundRequest.create({
      order_id: order.id, payment_id: payment.id, event_id: eventId,
      requested_by_user_id: me.id, requested_by_name: me.full_name || 'E2E',
      reason: 'E2E DAT-002 pendente', refund_type: 'partial', amount_requested: 40,
      status: 'pending',
    });
    try {
      // repetição enquanto a primeira ainda está pendente → rejeitada
      const dup = await invokeSafe(admin, 'requestRefund', {
        paymentId: payment.id, reason: 'E2E DAT-002 repetição',
        refundType: 'partial', manualApprove: true,
      });
      expect(dup.ok).toBe(false);

      // exatamente UMA RefundRequest pendente para o pagamento
      const reqs = await admin.entities.RefundRequest.filter({ payment_id: payment.id, is_deleted: false });
      expect(reqs.filter((r) => r.status === 'pending').length).toBe(1);
      expect(reqs.length).toBe(1);
      expect(reqs[0].id).toBe(pending.id);
    } finally {
      await admin.entities.RefundRequest.update(pending.id, { status: 'rejected', rejection_reason: 'E2E cleanup' }).catch(() => {});
      await admin.entities.Payment.delete(payment.id).catch(() => {});
      await admin.entities.Order.delete(order.id).catch(() => {});
    }
  });

  test('RR-2 reconciler: pendência com chave de idempotência converge UMA vez (falha terminal única, teto devolvido, ingresso destravado)', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip(!events?.length, 'nenhum evento ativo');
    const eventId = events[0].id;
    const me = await admin.auth.me();

    // fixture determinística: pagamento pago + ingresso travado refund_pending +
    // solicitação pendente SEM stripe_refund_id (falha de rede simulada na
    // criação do refund) com chave de idempotência. O reconciler re-tenta com a
    // MESMA chave contra um intent que não existe no Stripe → erro DEFINITIVO
    // (não de rede) → convergência terminal exatamente uma vez.
    const order = await admin.entities.Order.create({
      buyer_user_id: me.id, event_id: eventId, status: 'paid', total: 100,
      subtotal: 100, discount: 0, fulfillment_status: 'fulfilled',
    });
    const payment = await admin.entities.Payment.create({
      order_id: order.id, event_id: eventId, buyer_user_id: me.id,
      intent_id: `e2e_rr2_${Date.now()}`, amount: 100, amount_cents: 10000,
      currency: 'BRL', status: 'succeeded', provider: 'stripe', payment_method: 'card',
      refunded_amount: 40, fulfillment_status: 'fulfilled',
    });
    const ticket = await admin.entities.Ticket.create({
      order_id: order.id, order_item_id: '', event_id: eventId, ticket_type_id: '',
      holder_name: 'E2E DAT-002', holder_email: `e2e-dat2-${Date.now()}@example.com`,
      hash_code: `E2EDAT2${Date.now()}`, status: 'refund_pending',
    });
    const req = await admin.entities.RefundRequest.create({
      order_id: order.id, payment_id: payment.id, event_id: eventId,
      requested_by_user_id: me.id, requested_by_name: me.full_name || 'E2E',
      reason: 'E2E DAT-002 reconciler', refund_type: 'partial', amount_requested: 40,
      status: 'pending', idempotency_key: `e2e_rr2_key_${Date.now()}`,
    });
    try {
      const r1 = await invokeSafe(admin, 'expireStaleReservations', {});
      expect(r1.ok, r1.message).toBe(true);
      expect(r1.data.refunds_failed).toBeGreaterThanOrEqual(1);

      const freshReq = (await admin.entities.RefundRequest.filter({ id: req.id }))[0];
      expect(freshReq.status).toBe('failed');

      // teto pré-reservado devolvido EXATAMENTE uma vez
      const freshPayment = (await admin.entities.Payment.filter({ id: payment.id }))[0];
      expect(Number(freshPayment.refunded_amount || 0)).toBe(0);

      // ingresso destravado (refund_pending → issued)
      const freshTicket = (await admin.entities.Ticket.filter({ id: ticket.id }))[0];
      expect(freshTicket.status).toBe('issued');

      // execução repetida é idempotente: nada muda (não re-falha, não re-devolve)
      const r2 = await invokeSafe(admin, 'expireStaleReservations', {});
      expect(r2.ok, r2.message).toBe(true);
      const paymentAfter2 = (await admin.entities.Payment.filter({ id: payment.id }))[0];
      expect(Number(paymentAfter2.refunded_amount || 0)).toBe(0);
      const reqAfter2 = (await admin.entities.RefundRequest.filter({ id: req.id }))[0];
      expect(reqAfter2.status).toBe('failed');
    } finally {
      await admin.entities.RefundRequest.update(req.id, { status: 'rejected', rejection_reason: 'E2E cleanup' }).catch(() => {});
      await admin.entities.Ticket.delete(ticket.id).catch(() => {});
      await admin.entities.Payment.delete(payment.id).catch(() => {});
      await admin.entities.Order.delete(order.id).catch(() => {});
    }
  });
});

test.describe('Hardening crítico — PERF-001 paginação obrigatória de pedidos @hardening', () => {
  test('PM-1 paginação backend percorre TODOS os pedidos sem duplicar nem omitir; total exato', async () => {
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip(!events?.length, 'nenhum evento ativo');
    const eventId = events[0].id;

    // fixture: 3 pedidos novos (ids mais altos) com limite de página 2 →
    // obrigatoriamente ao menos 2 páginas.
    const created = [];
    for (let i = 0; i < 3; i++) {
      const o = await admin.entities.Order.create({
        buyer_user_id: 'e2e_pm1_fixture', event_id: eventId, status: 'cancelled',
        total: 0, fulfillment_status: 'pending', buyer_name: `E2E PM1 ${i}`,
        error_reason: 'E2E PERF-001 fixture',
      });
      created.push(o);
    }
    try {
      const res1 = await invokeSafe(admin, 'getEventOrders', { eventId, limit: 2 });
      expect(res1.ok, res1.message).toBe(true);
      expect(typeof res1.data.total).toBe('number');
      expect(res1.data.orders.length).toBeLessThanOrEqual(2);
      expect(res1.data.limit).toBe(2);
      expect(res1.data.has_more).toBe(true);

      const res2 = await invokeSafe(admin, 'getEventOrders', {
        eventId, limit: 2,
        ordersCursor: res1.data.orders_cursor,
        paymentsCursor: res1.data.payments_cursor || '',
      });
      expect(res2.ok, res2.message).toBe(true);

      const all = [...(res1.data.orders || []), ...(res2.data.orders || [])];
      const ids = all.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length); // sem duplicar
      for (const o of created) expect(ids).toContain(o.id); // sem omitir

      // total exato não depende da paginação
      const res3 = await invokeSafe(admin, 'getEventOrders', { eventId, limit: 500 });
      expect(res3.data.total).toBe(res1.data.total);
    } finally {
      for (const o of created) await admin.entities.Order.delete(o.id).catch(() => {});
    }
  });

  test('PM-2 usuário sem vínculo de gestão não acessa pedidos/métricas de outro evento (403)', async () => {
    const participant = await clientFor('participant');
    const admin = await clientFor('admin');
    const events = await admin.entities.Event.filter({ status: 'active', is_deleted: false });
    test.skip(!events?.length, 'nenhum evento ativo');
    const eventId = events[0].id;

    const orders = await invokeSafe(participant, 'getEventOrders', { eventId });
    expect(orders.ok).toBe(false);
    expect(orders.status).toBe(403);

    const summary = await invokeSafe(participant, 'getEventSalesSummary', { eventId });
    expect(summary.ok).toBe(false);
    expect(summary.status).toBe(403);

    // métricas globais são admin-only
    const metrics = await invokeSafe(participant, 'getSalesMetrics', {});
    expect(metrics.ok).toBe(false);
    expect(metrics.status).toBe(403);
  });
});
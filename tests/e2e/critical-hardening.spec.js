/**
 * Lote crítico de segurança/transação/privacidade — 2026-09-28.
 *
 * Cobertura permanente (cada teste reproduz a falha anterior e prova a correção):
 *   SEC-001  PersonDocument — escrita direta bloqueada para não-admin;
 *            managePersonDocument deriva person_id do autenticado e nunca
 *            transfere titularidade em update.
 *   SEC-002  expireStaleReservations — execução anônima/não-admin bloqueada
 *            (401/403); apenas admin autenticado ou credencial interna do
 *            scheduler (não forjável publicamente) executa.
 *   SEC-003  checkinTicket — claim atômico: scans concorrentes confirmam UMA
 *            entrada (1 auditoria); refund_pending/refunded nunca viram 'used'.
 *   SEC-004  requireActiveUser — controle positivo (conta ativa passa); o caso
 *            de conta excluída exige persona com account_status='deleted'
 *            semeada (ver TEST-CATALOG, marcado como fixture pendente).
 *   INF-001  import_lookup — escopo estrito do evento autorizado (nenhum
 *            registro/e-mail/CPF de outro evento); não-gestão recebe 403.
 *   INF-002  getPartnerPersons — sem catálogo global; só vinculadas ao parceiro
 *            + busca mínima de >=3 chars; campos mínimos; parceiro alheio → 403.
 *   FIN-003  managePayouts — papel 'team' barrado em ações financeiras
 *            (startOnboarding/setReserve).
 *   DAT-001  Coupon.code único por evento (create duplicado, update para código
 *            existente e diagnóstico de legados).
 *
 * Fora do alcance executável desta suíte (exigem fixtures de comércio/Stripe):
 *   FIN-001 (concorrência de checkouts), FIN-002 (reserva atômica de cupom no
 *   checkout), DAT-002 (idempotência de estorno parcial) — ver TEST-CATALOG.
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
  test('SR-1 chamada sem autenticação é bloqueada (401) — nunca executa mutações financeiras', async () => {
    const anon = createClient({ appId: APP_ID, appBaseUrl: APP_URL, requiresAuth: true });
    // sem login — nenhuma sessão
    await expect(
      anon.functions.invoke('expireStaleReservations', {})
    ).rejects.toBeTruthy();
  });

  test('SR-2 usuário autenticado não-admin recebe 403', async () => {
    const manager = await clientFor('manager');
    const res = await invokeSafe(manager, 'expireStaleReservations', {});
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
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
  test('PP-1 sem catálogo global: só vinculadas ao parceiro + busca mínima com campos mínimos', async () => {
    const partner = await clientFor('partner');
    const res0 = await invokeSafe(partner, 'getManagedPartners', {});
    test.skip(!res0.ok || !res0.data?.partners?.length, 'partner persona sem parceiro gerido semeado');
    const partnerId = res0.data.partners[0].id;

    const res = await invokeSafe(partner, 'getPartnerPersons', { partnerId });
    expect(res.ok, res.message).toBe(true);
    for (const p of res.data.persons || []) {
      expect(Object.keys(p).sort()).toEqual(['contact_email', 'full_name', 'id', 'is_active'].sort());
    }

    // busca explícita < 3 chars: NÃO busca externa (só vinculadas)
    const short = await invokeSafe(partner, 'getPartnerPersons', { partnerId, search: 'ab' });
    expect(short.ok, short.message).toBe(true);

    // busca explícita de termo inexistente: teto respeitado, campos mínimos
    const search = await invokeSafe(partner, 'getPartnerPersons', {
      partnerId,
      search: `zzqx-${Date.now()}`,
    });
    expect(search.ok, search.message).toBe(true);
    expect((search.data.persons || []).length).toBeLessThanOrEqual(21);
  });

  test('PP-2 partner manager não consulta Persons de parceiro alheio', async () => {
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

test.describe('Hardening crítico — DAT-001 unicidade de cupom por evento @security @rls @hardening', () => {
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
});
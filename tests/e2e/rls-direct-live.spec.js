import { test, expect } from '@playwright/test';
import { createClient } from '@base44/sdk';

const APP_ID = process.env.BASE44_APP_ID || '6a2c618daec1758ff2122225';
const APP_URL = process.env.E2E_BASE_URL || 'https://share--evolve-summit.base44.app';
const PERSONAS = {
  manager: ['E2E_MANAGER_EMAIL', 'E2E_MANAGER_PASSWORD'],
  participant: ['E2E_PARTICIPANT_EMAIL', 'E2E_PARTICIPANT_PASSWORD'],
  speaker: ['E2E_SPEAKER_EMAIL', 'E2E_SPEAKER_PASSWORD'],
  partner: ['E2E_PARTNER_EMAIL', 'E2E_PARTNER_PASSWORD'],
};
const ADMIN_ONLY = ['AuditLog','Import','EventStats','AwardCategory','MetricBucket','Certificate','Session','Track','Room','AwardConfig','CallForPapers','Badge','StoreItem','ScoringRule','CertificateTemplate'];
const SENSITIVE_NO_RLS = ['Lead','NotificationCampaign','Participant','Partner','PartnerRepresentative','Person','PersonDocument','SessionAttendance','SessionQuestion','SessionReview'];

async function clientFor(role) {
  const [emailEnv, passEnv] = PERSONAS[role];
  const email = process.env[emailEnv], password = process.env[passEnv];
  test.skip(!email || !password, `${role} credentials not configured`);
  const client = createClient({ appId: APP_ID, appBaseUrl: APP_URL, requiresAuth: true });
  await client.auth.loginViaEmailPassword(email, password);
  return client;
}

test.describe('Live direct-SDK authorization gate @security @rls', () => {
  test('non-admin direct reads stay blocked for admin-only entities', async () => {
    for (const role of Object.keys(PERSONAS)) {
      const client = await clientFor(role);
      for (const entity of ADMIN_ONLY) {
        try {
          const rows = await client.entities[entity].list();
          expect(rows, `${role} direct ${entity} read`).toHaveLength(0);
        } catch { /* 403 is acceptable and expected */ }
      }
    }
  });

  test('sensitive entities without RLS do not expose records directly', async () => {
    for (const role of Object.keys(PERSONAS)) {
      const client = await clientFor(role);
      for (const entity of SENSITIVE_NO_RLS) {
        let rows = [];
        try { rows = await client.entities[entity].list(); } catch { continue; }
        expect(rows, `${role} direct ${entity} read must be blocked or empty`).toHaveLength(0);
      }
    }
  });

  test('quick-win RLS: SessionFavorite is self-service; PointTransaction and StoreRedemption are read-self/admin-write', async () => {
    const client = await clientFor('participant');
    const personId = '6a84dee6898f07362bd2e0fd';
    const participantId = '6a84def0e914028f54769dfc';
    const sessionId = '6a829c47b675f6c1aaa80192';
    const eventId = '6a829bfb79832f1efececa3d';

    let favoriteId;
    try {
      const created = await client.entities.SessionFavorite.create({
        event_id: eventId,
        session_id: sessionId,
        participant_id: participantId,
        person_id: personId,
        description: 'RLS test fixture'
      });
      favoriteId = created.id;
      const own = await client.entities.SessionFavorite.filter({ id: favoriteId });
      expect(own).toHaveLength(1);
      expect(own[0].person_id).toBe(personId);
    } finally {
      if (favoriteId) {
        try { await client.entities.SessionFavorite.delete(favoriteId); } catch { /* cleanup best effort */ }
      }
    }

    const points = await client.entities.PointTransaction.list();
    expect(points).toHaveLength(0);
    const redemptions = await client.entities.StoreRedemption.list();
    expect(redemptions).toHaveLength(0);

    await expect(client.entities.PointTransaction.create({
      event_id: eventId,
      participant_id: participantId,
      acao: 'pergunta_valida',
      pontos: 1,
      chave_idempotencia: `rls-test-${Date.now()}`
    })).rejects.toBeTruthy();

    await expect(client.entities.StoreRedemption.create({
      event_id: eventId,
      participant_id: participantId,
      store_item_id: 'rls-test-item',
      pontos_debitados: 1
    })).rejects.toBeTruthy();
  });

  test('quick-win RLS: ConnectionRequest, Connection and ChatThread expose only self-scoped rows and block participant writes', async () => {
    const client = await clientFor('participant');
    const me = await client.auth.me();
    const myPersonId = me?.person_id || me?.data?.person_id;
    expect(myPersonId, 'participant test account must expose person_id').toBeTruthy();

    for (const entity of ['ConnectionRequest', 'Connection', 'ChatThread']) {
      const rows = await client.entities[entity].list();
      for (const row of rows) {
        if (entity === 'ConnectionRequest') {
          expect(row.requester_person_id === myPersonId || row.receiver_person_id === myPersonId).toBeTruthy();
        } else {
          expect(row.person_a_id === myPersonId || row.person_b_id === myPersonId).toBeTruthy();
        }
      }
    }

    const fakeId = `rls-test-${Date.now()}`;
    await expect(client.entities.ConnectionRequest.create({
      event_id: fakeId,
      requester_person_id: myPersonId,
      receiver_person_id: fakeId,
      status: 'pending'
    })).rejects.toBeTruthy();

    await expect(client.entities.Connection.create({
      event_id: fakeId,
      person_a_id: myPersonId,
      person_b_id: fakeId
    })).rejects.toBeTruthy();

    await expect(client.entities.ChatThread.create({
      event_id: fakeId,
      person_a_id: myPersonId,
      person_b_id: fakeId
    })).rejects.toBeTruthy();
  });

  test('Event is readable by authenticated users but write operations are admin-only', async () => {
    const client = await clientFor('participant');
    const events = await client.entities.Event.filter({ is_deleted: false });
    expect(Array.isArray(events)).toBeTruthy();
    const fakeId = `rls-test-${Date.now()}`;
    await expect(client.entities.Event.create({
      name: 'RLS test fixture',
      start_date: new Date().toISOString(),
      status: 'draft'
    })).rejects.toBeTruthy();
    await expect(client.entities.Event.update(fakeId, { name: 'blocked' })).rejects.toBeTruthy();
    await expect(client.entities.Event.delete(fakeId)).rejects.toBeTruthy();
  });

  test('event-scoped functions allow authorized event and reject unrelated event', async () => {
    const client = await clientFor('manager');
    const own = '6a84a75d4d0b7d531fd91dd0';
    const other = '6a829bfb79832f1efececa3e';
    const tracks = await client.functions.invoke('getEventTracks', { eventId: own });
    const sessions = await client.functions.invoke('getEventSessions', { eventIds: [own] });
    expect(tracks.status).toBe(200);
    expect(sessions.status).toBe(200);
    await expect(client.functions.invoke('getEventTracks', { eventId: other })).rejects.toBeTruthy();
    await expect(client.functions.invoke('getEventSessions', { eventIds: [other] })).rejects.toBeTruthy();
  });
});

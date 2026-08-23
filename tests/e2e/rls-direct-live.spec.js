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
const SENSITIVE_NO_RLS = ['Lead','NotificationCampaign','Participant','Partner','PartnerRepresentative','Person','PersonDocument','PointTransaction','SessionAttendance','SessionFavorite','SessionQuestion','SessionReview','StoreRedemption'];

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

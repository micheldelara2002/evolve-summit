import { test, expect } from '@playwright/test';
import { createClient } from '@base44/sdk';
import fs from 'node:fs';

const APP_ID = '6a2c618daec1758ff2122225';
const APP_URL = 'https://share--evolve-summit.base44.app';
const EVENT_A = '6a84a75d4d0b7d531fd91dd0';

function clientFromState(role) {
  const state = JSON.parse(fs.readFileSync(`tests/.auth/${role}.json`, 'utf8'));
  const origin = state.origins?.find(o => o.origin === APP_URL) || state.origins?.[0];
  const token = origin?.localStorage?.find(x => x.name === 'base44_access_token')?.value
    || origin?.localStorage?.find(x => x.name === 'token')?.value;
  if (!token) throw new Error(`No auth token in tests/.auth/${role}.json`);
  const client = createClient({ appId: APP_ID, appBaseUrl: APP_URL, requiresAuth: true });
  client.auth.setToken(token, false);
  return client;
}

test.describe('RLS quick wins — MetricBucket + Certificate @security', () => {
  test('MetricBucket direct SDK is blocked for all non-admin personas', async () => {
    for (const role of ['participant', 'speaker', 'manager', 'partner']) {
      const client = clientFromState(role);
      const records = await client.entities.MetricBucket.list();
      expect(records, `${role} must not read MetricBucket directly`).toHaveLength(0);
    }
  });

  test('non-admin cannot read MetricBucket and cannot use admin-only dashboard metrics directly', async () => {
    const manager = clientFromState('manager');
    const records = await manager.entities.MetricBucket.list();
    expect(records).toHaveLength(0);

    const metrics = await manager.functions.invoke('getBusinessDashboardMetrics', { eventId: EVENT_A }).catch(e => ({ status: e?.response?.status || 403 }));
    expect([403, 401]).toContain(metrics.status);
  });

  test('Certificate direct SDK is blocked for non-admin while public validation remains available', async () => {
    const issuer = clientFromState('manager');
    const participant = clientFromState('participant');
    const manager = clientFromState('manager');

    const participants = await issuer.entities.Participant.filter({ event_id: EVENT_A, is_deleted: false });
    const participantFixture = participants.find(p => p.person_id) || participants[0];
    test.skip(!participantFixture, 'No participant fixture available for certificate issuance.');

    let certificate;
    try {
      const issue = await issuer.functions.invoke('issueCertificate', {
        eventId: EVENT_A,
        participantId: participantFixture.id,
        tipo: 'participacao',
        template: 'classico',
      });
      expect(issue.status).toBe(200);
      certificate = issue.data?.certificate;
      expect(certificate?.hash_code).toBeTruthy();

      for (const [role, client] of [['participant', participant], ['manager', manager]]) {
        const direct = await client.entities.Certificate.list();
        expect(direct, `${role} direct Certificate read must be blocked`).toHaveLength(0);
      }

      const validation = await participant.functions.invoke('validateCertificate', { hashCode: certificate.hash_code });
      expect(validation.status).toBe(200);
      expect(validation.data?.valid).toBe(true);
      expect(validation.data?.certificate?.hash_code).toBe(certificate.hash_code);
      expect(validation.data?.certificate?.person_name).toBeTruthy();
      expect(validation.data?.certificate?.event_name).toBeTruthy();
      expect(validation.data?.certificate?.issued_by_user_id).toBeUndefined();
      expect(validation.data?.certificate?.participant_id).toBeUndefined();
      expect(validation.data?.certificate?.email_sent).toBeUndefined();

      const invalid = await participant.functions.invoke('validateCertificate', { hashCode: `INVALID-${Date.now()}` });
      expect(invalid.status).toBe(200);
      expect(invalid.data?.valid).toBe(false);
    } finally {
      if (certificate?.id) {
        try { await issuer.entities.Certificate.update(certificate.id, { is_deleted: true }); } catch {}
      }
    }
  });
});

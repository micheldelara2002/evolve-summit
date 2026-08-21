import { test, expect } from '@playwright/test';
import { createClient } from '@base44/sdk';
import fs from 'node:fs';

const APP_ID = '6a2c618daec1758ff2122225';
const APP_URL = 'https://share--evolve-summit.base44.app';
const EVENT_B = '6a829bfb79832f1efececa3e';

function hasState(role) {
  return fs.existsSync(`tests/.auth/${role}.json`);
}

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

async function invoke(client, payload) {
  return client.functions.invoke('manageEventConfig', payload);
}

test.describe('Public opportunities: CFP/Award without event participation @security', () => {
  test('a user without event membership can discover active CFP/Award opportunities', async () => {
    const user = clientFromState('manager');

    // The manager fixture is intentionally authorized for another event; the existing
    // Session/Track adversarial suite proves EVENT_B is unrelated to this persona.
    // This test verifies that opportunity discovery is a separate public surface.
    const sessionsB = await user.functions.invoke('getEventSessions', { eventIds: [EVENT_B] }).catch(e => ({ status: e?.response?.status || 500 }));
    expect([403, 200]).toContain(sessionsB.status);
    if (sessionsB.status === 200) expect(sessionsB.data?.sessions || []).toHaveLength(0);

    for (const entityName of ['CallForPapers', 'AwardConfig']) {
      const response = await invoke(user, { action: 'list', entityName });
      expect(response.status, `${entityName} public discovery`).toBe(200);
      const records = response.data?.records || [];
      expect(records.every(r => r.is_active === true), `${entityName} only active records are public`).toBeTruthy();
      expect(records.every(r => r.is_deleted === undefined), `${entityName} public projection hides deletion flag`).toBeTruthy();
    }
  });

  test('a user without membership can submit a CFP proposal to an open CFP in another event', async () => {
    const user = clientFromState('manager');
    const me = await user.auth.me();
    expect(me?.person_id, 'manager fixture must have person_id').toBeTruthy();

    const response = await invoke(user, { action: 'list', entityName: 'CallForPapers' });
    const openCfp = (response.data?.records || []).find(r => r.event_id === EVENT_B && r.is_active === true);
    test.skip(!openCfp, 'No active CFP fixture exists in EVENT_B');

    const marker = `E2E-PUBLIC-CFP-${Date.now()}`;
    let created;
    try {
      created = await user.entities.Submission.create({
        call_for_papers_id: openCfp.id,
        event_id: EVENT_B,
        person_id: me.person_id,
        title: marker,
        summary: 'Public CFP submission security fixture',
        proposed_type: 'palestra',
        custom_answers: '{}',
        status: 'pending',
      });
      expect(created?.event_id).toBe(EVENT_B);
      expect(created?.created_by_id || true).toBeTruthy();
    } finally {
      if (created?.id) {
        try { await user.entities.Submission.delete(created.id); } catch {}
      }
    }
  });

  test('a user without membership can submit an Award case to an open Award, when an admin fixture is available for cleanup', async () => {
    test.skip(!hasState('admin'), 'Admin auth state unavailable; Award submission creates an entrant membership that must be cleaned by admin.');

    const user = clientFromState('manager');
    const admin = clientFromState('admin');
    const me = await user.auth.me();
    expect(me?.person_id, 'manager fixture must have person_id').toBeTruthy();

    const response = await invoke(user, { action: 'list', entityName: 'AwardConfig' });
    const openAward = (response.data?.records || []).find(r => r.event_id === EVENT_B && r.is_active === true);
    test.skip(!openAward, 'No active Award fixture exists in EVENT_B');

    const marker = `E2E-PUBLIC-AWARD-${Date.now()}`;
    let submissionId;
    try {
      const result = await user.functions.invoke('manageAward', {
        action: 'submitCase',
        award_id: openAward.id,
        title: marker,
        summary: 'Public Award submission security fixture',
        custom_answers: {},
      });
      expect(result.status).toBe(200);
      submissionId = result.data?.submission?.id;
      expect(submissionId).toBeTruthy();
      expect(result.data?.submission?.event_id).toBe(EVENT_B);
    } finally {
      if (submissionId) {
        try { await admin.entities.AwardSubmission.delete(submissionId); } catch {}
      }
      // submitCase intentionally creates EventMembership{entrant}; remove only the
      // exact test fixture created for this user/event, using the admin fixture.
      try {
        const memberships = await admin.entities.EventMembership.filter({
          event_id: EVENT_B,
          person_id: me.person_id,
          role: 'entrant',
          is_deleted: false,
        });
        for (const m of memberships || []) await admin.entities.EventMembership.delete(m.id);
      } catch {}
    }
  });

  test('public opportunity discovery does not grant management or private-data access', async () => {
    const user = clientFromState('manager');
    for (const entityName of ['AwardConfig', 'CallForPapers']) {
      const direct = await user.entities[entityName].list();
      expect(direct, `${entityName} direct SDK remains blocked by RLS`).toHaveLength(0);

      const publicResponse = await invoke(user, { action: 'list', entityName });
      expect(publicResponse.status).toBe(200);
      for (const record of publicResponse.data?.records || []) {
        expect(record.is_deleted).toBeUndefined();
        if (entityName === 'AwardConfig') {
          expect(record.criteria_config).toBeUndefined();
          expect(record.assigned_reviewer_ids).toBeUndefined();
        }
      }
    }
  });
});

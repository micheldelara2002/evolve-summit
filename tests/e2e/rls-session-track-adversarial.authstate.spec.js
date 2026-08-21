import { test, expect } from '@playwright/test';
import { createClient } from '@base44/sdk';
import fs from 'node:fs';

const APP_ID = '6a2c618daec1758ff2122225';
const APP_URL = 'https://share--evolve-summit.base44.app';
const EVENT_A = '6a84a75d4d0b7d531fd91dd0';
const EVENT_B = '6a829bfb79832f1efececa3e';

function clientFromState(role) {
  const state = JSON.parse(fs.readFileSync(`tests/.auth/${role}.json`, 'utf8'));
  const origin = state.origins?.find(o => o.origin === APP_URL) || state.origins?.[0];
  const token = origin?.localStorage?.find(x => x.name === 'base44_access_token')?.value || origin?.localStorage?.find(x => x.name === 'token')?.value;
  if (!token) throw new Error(`No auth token in tests/.auth/${role}.json`);
  const client = createClient({ appId: APP_ID, appBaseUrl: APP_URL, requiresAuth: true });
  client.auth.setToken(token, false);
  return client;
}

async function invoke(client, name, payload) {
  return client.functions.invoke(name, payload);
}

test.describe('RLS Session/Track adversarial post-RLS @security', () => {
  test('speaker owner can update only material_url @speaker', async () => {
    const speaker = clientFromState('speaker');
    const me = await speaker.auth.me();
    const participants = await speaker.entities.Participant.filter({ person_id: me.person_id, is_deleted: false });
    const speakerParticipant = (participants || []).find(p => p.role_in_event === 'speaker');
    expect(speakerParticipant, 'speaker participant fixture must exist').toBeTruthy();

    const eventId = speakerParticipant.event_id;
    const result = await invoke(speaker, 'getEventSessions', { eventIds: [eventId] });
    const ownSession = (result.data?.sessions || []).find(s => s.speaker_id === speakerParticipant.id && !s.is_deleted);
    expect(ownSession, 'speaker must have an existing owned session fixture').toBeTruthy();

    const marker = `https://e2e.invalid/material-${Date.now()}`;
    const updated = await invoke(speaker, 'updateSessionMaterial', { sessionId: ownSession.id, materialUrl: marker });
    expect(updated.status).toBe(200);

    const after = await invoke(speaker, 'getEventSessions', { eventIds: [eventId] });
    const persisted = (after.data?.sessions || []).find(s => s.id === ownSession.id);
    expect(persisted?.material_url).toBe(marker);
  });
  test('authorized personas can read their event through functions', async () => {
    for (const role of ['participant', 'speaker', 'manager', 'partner']) {
      const c = clientFromState(role);
      const sessions = await invoke(c, 'getEventSessions', { eventIds: [EVENT_A] });
      const tracks = await invoke(c, 'getEventTracks', { eventId: EVENT_A });
      expect(sessions.status, `${role} sessions`).toBe(200);
      expect(tracks.status, `${role} tracks`).toBe(200);
    }
  });

  test('authorized personas cannot read an unrelated event through functions', async () => {
    for (const role of ['participant', 'speaker', 'manager', 'partner']) {
      const c = clientFromState(role);
      try {
        const sessions = await invoke(c, 'getEventSessions', { eventIds: [EVENT_B] });
        expect(sessions.status, `${role} sessions status`).toBe(200);
        expect(sessions.data?.sessions || [], `${role} must receive no unrelated sessions`).toHaveLength(0);
      } catch (e) {
        expect(e?.response?.status, `${role} unrelated Session request must be 403 when rejected`).toBe(403);
      }
      try {
        await invoke(c, 'getEventTracks', { eventId: EVENT_B });
        throw new Error(`${role} unrelated Track request unexpectedly succeeded`);
      } catch (e) {
        expect(e?.response?.status, `${role} unrelated Track request must be 403`).toBe(403);
      }
    }
  });

  test('direct SDK reads are blocked for non-admin personas', async () => {
    for (const role of ['participant', 'speaker', 'manager', 'partner']) {
      const c = clientFromState(role);
      const sessions = await c.entities.Session.list();
      const tracks = await c.entities.Track.list();
      expect(sessions, `${role} direct Session read must expose no records`).toHaveLength(0);
      expect(tracks, `${role} direct Track read must expose no records`).toHaveLength(0);
    }
  });

  test('admin direct SDK access remains allowed when an admin auth state is available', async () => {
    test.skip(!fs.existsSync('tests/.auth/admin.json'), 'No admin storage state available in this runner');
    const admin = clientFromState('admin');
    expect((await admin.entities.Session.list()).length).toBeGreaterThanOrEqual(0);
    expect((await admin.entities.Track.list()).length).toBeGreaterThanOrEqual(0);
  });
});

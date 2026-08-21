import { test, expect } from '@playwright/test';
import { createClient } from '@base44/sdk';

const appId = process.env.BASE44_APP_ID || '6a2c618daec1758ff2122225';
const baseUrl = process.env.E2E_BASE_URL;
const eventId = process.env.E2E_EVENT_ID || '6a84a75d4d0b7d531fd91dd0';

async function login(email, password) {
  const client = createClient({ appId, appBaseUrl: baseUrl, requiresAuth: true });
  await client.auth.loginViaEmailPassword(email, password);
  return client;
}

async function findOwnSpeakerSession(admin, speakerEmail) {
  const people = await admin.entities.Person.filter({ contact_email: speakerEmail });
  const personId = people?.[0]?.id;
  const participants = await admin.entities.Participant.filter({ event_id: eventId, person_id: personId, role_in_event: 'speaker', is_deleted: false });
  const participantId = participants?.[0]?.id;
  if (!participantId) return null;
  const sessions = await admin.entities.Session.filter({ speaker_id: participantId, is_deleted: false });
  return sessions?.[0] || null;
}

test.describe('RLS Session/Track adversarial pre-RLS @security @rls @participant', () => {
  test('authorized personas can read their event through functions', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const personas = [
      ['participant', process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD],
      ['speaker', process.env.E2E_SPEAKER_EMAIL, process.env.E2E_SPEAKER_PASSWORD],
      ['manager', process.env.E2E_MANAGER_EMAIL, process.env.E2E_MANAGER_PASSWORD],
      ['partner', process.env.E2E_PARTNER_EMAIL, process.env.E2E_PARTNER_PASSWORD],
    ];
    for (const [name, email, password] of personas) {
      const client = await login(email, password);
      const sessions = await client.functions.invoke('getEventSessions', { eventIds: [eventId] });
      const tracks = await client.functions.invoke('getEventTracks', { eventId });
      expect(sessions.status, `${name} sessions`).toBe(200);
      expect(tracks.status, `${name} tracks`).toBe(200);
    }
  });

  test('authorized personas are denied by functions for an unrelated event', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const unrelatedEvent = '6a829bfb79832f1efececa3e';
    const personas = [
      ['participant', process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD],
      ['speaker', process.env.E2E_SPEAKER_EMAIL, process.env.E2E_SPEAKER_PASSWORD],
      ['manager', process.env.E2E_MANAGER_EMAIL, process.env.E2E_MANAGER_PASSWORD],
      ['partner', process.env.E2E_PARTNER_EMAIL, process.env.E2E_PARTNER_PASSWORD],
    ];
    for (const [name, email, password] of personas) {
      const client = await login(email, password);
      await expect(client.functions.invoke('getEventTracks', { eventId: unrelatedEvent })).rejects.toBeTruthy();
      const sessions = await client.functions.invoke('getEventSessions', { eventIds: [unrelatedEvent] });
      expect(sessions.status, `${name} cross-event sessions`).toBe(200);
      expect(sessions.data.sessions || [], `${name} must receive no unrelated sessions`).toHaveLength(0);
    }
  });

  test('speaker owner can update only material_url; non-owner cannot', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = await login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD);
    const speakerEmail = process.env.E2E_SPEAKER_EMAIL;
    let ownSession = await findOwnSpeakerSession(admin, speakerEmail);
    if (!ownSession) {
      const people = await admin.entities.Person.filter({ contact_email: speakerEmail });
      const personId = people?.[0]?.id;
      const speakerParts = await admin.entities.Participant.filter({ event_id: eventId, person_id: personId, role_in_event: 'speaker', is_deleted: false });
      const speakerParticipantId = speakerParts?.[0]?.id;
      expect(speakerParticipantId, 'E2E speaker participant must exist').toBeTruthy();
      const tracks = await admin.entities.Track.filter({ event_id: eventId, is_deleted: false });
      const rooms = await admin.entities.Room.filter({ event_id: eventId, is_deleted: false });
      ownSession = await admin.entities.Session.create({
        event_id: eventId, title: 'E2E RLS Speaker-Owned Session', description: 'temporary adversarial fixture',
        speaker_id: speakerParticipantId, speaker_name: 'E2E Speaker',
        track_id: tracks?.[0]?.id || '', room_id: rooms?.[0]?.id || '',
        session_type: 'palestra', start_time: new Date().toISOString(), end_time: new Date(Date.now()+3600000).toISOString(),
        capacity: 10, is_deleted: false, material_url: '',
      });
    }

    const speaker = await login(speakerEmail, process.env.E2E_SPEAKER_PASSWORD);
    const before = ownSession.material_url || '';
    const marker = `https://e2e.invalid/material-${Date.now()}`;
    const updated = await speaker.functions.invoke('updateSessionMaterial', {
      sessionId: ownSession.id,
      materialUrl: marker,
    });
    expect(updated.status).toBe(200);

    const after = await admin.entities.Session.get(ownSession.id);
    expect(after.material_url).toBe(marker);

    // Restore the fixture through admin so the test is repeatable.
    await admin.entities.Session.update(ownSession.id, { material_url: before });

    const participant = await login(process.env.E2E_PARTICIPANT_EMAIL, process.env.E2E_PARTICIPANT_PASSWORD);
    await expect(participant.functions.invoke('updateSessionMaterial', {
      sessionId: ownSession.id,
      materialUrl: 'https://e2e.invalid/unauthorized',
    })).rejects.toBeTruthy();
  });
});

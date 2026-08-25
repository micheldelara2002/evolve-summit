#!/usr/bin/env node
// =============================================================================
// E2E Bootstrap — idempotent seed for the Evolve Summit regression environment.
// =============================================================================
// - Operates ONLY against E2E_BASE_URL (must be the TEST/preview app, never prod).
// - Authenticates as an admin (E2E_ADMIN_*) to create/link test data.
// - The 5 persona USERS must already be registered in the test app (Users cannot
//   be created via the SDK — only invited). Bootstrap resolves them by email
//   and links Participants / EventMemberships / PartnerRepresentative to them.
// - Idempotent: re-running is safe (existing records are reused, never duplicated).
// - Writes tests/.e2e-env.json with { E2E_EVENT_ID } so subsequent runs pick it up.
//
// Required env (see tests/.env.e2e.example):
//   E2E_BASE_URL, BASE44_APP_ID, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD,
//   E2E_MANAGER_EMAIL/PASSWORD, E2E_STAFF_*, E2E_PARTICIPANT_*,
//   E2E_SPEAKER_*, E2E_PARTNER_*
// Optional: BASE44_API_URL (Base44 API server, if not inferred from app URL).
// =============================================================================
import { createClient } from '@base44/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadE2EEnv, PERSONAS, MARKER, PARTNER_TRADE, SEED_TAG, STATE_FILE } from './lib-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

loadE2EEnv();

const BASE_URL = process.env.E2E_BASE_URL;
const APP_ID = process.env.BASE44_APP_ID || process.env.VITE_BASE44_APP_ID;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const API_URL = process.env.BASE44_API_URL || '';

const log = (m) => console.log(`[bootstrap] ${m}`);
const warn = (m) => console.warn(`[bootstrap] ⚠ ${m}`);
const die = (m) => { console.error(`[bootstrap] ✖ ${m}`); process.exit(1); };

if (!BASE_URL) die('E2E_BASE_URL is required (point to the TEST app).');
if (!APP_ID) die('BASE44_APP_ID is required.');
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) die('E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD are required.');
if (process.env.E2E_ALLOW_PROD !== '1' && /prod/i.test(BASE_URL)) {
  warn(`E2E_BASE_URL looks like production (${BASE_URL}). Set E2E_ALLOW_PROD=1 only if intentional.`);
}

const client = createClient({
  appId: APP_ID,
  token: undefined,
  ...(API_URL ? { serverUrl: API_URL } : {}),
  appBaseUrl: BASE_URL,
  requiresAuth: true,
});

// --- helpers ----------------------------------------------------------------
async function filter(entity, query) {
  try { return await client.entities[entity].filter(query); } catch (e) { warn(`${entity}.filter failed: ${e.message}`); return []; }
}
async function getOrCreate(entity, query, payload) {
  const existing = await filter(entity, query);
  if (existing && existing.length) return { rec: existing[0], created: false };
  try {
    const rec = await client.entities[entity].create(payload);
    return { rec, created: true };
  } catch (e) {
    warn(`${entity}.create failed: ${e.message}`);
    return { rec: null, created: false };
  }
}
async function resolveUser(email) {
  if (!email) return null;
  const users = await filter('User', { email });
  return users && users[0] ? users[0] : null;
}
function iso(daysFromNow = 0) {
  return new Date(Date.now() + daysFromNow * 86400000).toISOString();
}

// --- main -------------------------------------------------------------------
async function main() {
  log(`Authenticating admin ${ADMIN_EMAIL} against ${BASE_URL} ...`);
  try {
    await client.auth.loginViaEmailPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
  } catch (e) {
    die(`Admin login failed: ${e.message}`);
  }
  const me = await client.auth.me().catch(() => null);
  if (!me) die('auth.me() returned no user after login.');
  if (me.role !== 'admin') die(`Authenticated user is not admin (role=${me.role}). Bootstrap requires an admin on the TEST app.`);
  log(`Admin OK (${me.email}, role=${me.role}).`);

  // Resolve persona users (must pre-exist).
  const personas = {};
  for (const p of PERSONAS) {
    const email = process.env[p.emailEnv];
    if (!email) { warn(`${p.emailEnv} not set — persona ${p.key} will be skipped.`); personas[p.key] = null; continue; }
    const user = await resolveUser(email);
    if (!user) warn(`Persona user not found for ${p.key} (${email}). Register/invite them in the TEST app first.`);
    personas[p.key] = user;
  }

  const managerUser = personas.manager;
  if (!managerUser) warn('No manager persona resolved — Event.manager_id will be empty.');

  // 1. Event
  const { rec: event } = await getOrCreate('Event',
    { name: MARKER, is_deleted: false },
    {
      name: MARKER,
      description: 'Evento dedicado de regressão E2E. NÃO usar em produção.',
      start_date: iso(0), end_date: iso(1), location: 'E2E Virtual',
      status: 'active', manager_id: managerUser?.id || '', manager_name: managerUser?.full_name || 'E2E Manager',
      color_primary: '#4F46E5', color_secondary: '#0D9488', color_accent: '#F59E0B',
      max_participants: 500,
    });
  if (!event) die('Could not create/resolve regression Event.');
  log(`Event: ${event.id} (${MARKER})`);

  // 2. People + Participants + Memberships per persona
  for (const p of PERSONAS) {
    const user = personas[p.key];
    const email = process.env[p.emailEnv];
    if (!user || !email) continue;
    const { rec: person } = await getOrCreate('Person', { contact_email: email },
      { full_name: user.full_name || `E2E ${p.key}`, contact_email: email, is_active: true, created_day: iso(0).slice(0, 10), metrics_inc: true });
    const { rec: participant } = await getOrCreate('Participant', { event_id: event.id, email, is_deleted: false },
      {
        event_id: event.id, full_name: user.full_name || `E2E ${p.key}`, email,
        role_in_event: p.roleInEvent, registration_status: 'confirmed',
        checkin_status: p.key === 'participant' ? 'confirmed' : 'pending',
        import_id: SEED_TAG, person_id: person?.id || '', bio: MARKER, is_eligible: true,
      });
    await getOrCreate('EventMembership', { event_id: event.id, person_id: person?.id || '', role: p.membership, is_deleted: false },
      {
        event_id: event.id, person_id: person?.id || '', person_name: user.full_name || `E2E ${p.key}`,
        user_id: user.id, user_email: email, role: p.membership, is_active: true,
      });
    log(`${p.key}: person=${person?.id || '-'} participant=${participant?.id || '-'}`);
  }

  // 3. Partner + EventPartner + PartnerRepresentative
  const { rec: partner } = await getOrCreate('Partner', { legal_document_number: '00000000000001', is_deleted: false },
    {
      legal_name: 'E2E Partner Ltda', trade_name: PARTNER_TRADE,
      legal_country_code: 'BR', legal_document_type: 'CNPJ', legal_document_number: '00000000000001',
      contact_email: process.env.E2E_PARTNER_EMAIL || '', is_active: true, created_day: iso(0).slice(0, 10),
    });
  if (partner) {
    await getOrCreate('EventPartner', { event_id: event.id, partner_id: partner.id, is_deleted: false },
      { event_id: event.id, partner_id: partner.id, is_active: true });
    const partnerUser = personas.partner;
    if (partnerUser) {
      const partnerPerson = (await filter('Person', { contact_email: partnerUser.email }))[0];
      if (partnerPerson) {
        await getOrCreate('PartnerRepresentative', { partner_id: partner.id, person_id: partnerPerson.id, is_deleted: false },
          { partner_id: partner.id, person_id: partnerPerson.id, user_id: partnerUser.id, is_active: true });
      }
    }
    log(`Partner: ${partner.id}`);
  }

  // 4. Content: Track, Room, Session (speaker)
  const { rec: track } = await getOrCreate('Track', { event_id: event.id, name: 'E2E Track', is_deleted: false },
    { event_id: event.id, name: 'E2E Track' });
  const { rec: room } = await getOrCreate('Room', { event_id: event.id, name: 'E2E Room', is_deleted: false },
    { event_id: event.id, name: 'E2E Room', capacity: 100 });
  const speakerPart = (await filter('Participant', { event_id: event.id, role_in_event: 'speaker', is_deleted: false }))[0];
  await getOrCreate('Session', { event_id: event.id, title: 'E2E Session', is_deleted: false },
    {
      event_id: event.id, track_id: track?.id || '', room_id: room?.id || '',
      title: 'E2E Session', description: MARKER, session_type: 'palestra',
      speaker_id: speakerPart?.id || '', speaker_name: speakerPart?.full_name || 'E2E Speaker',
      start_time: iso(0), end_time: iso(0), capacity: 100,
    });
  log('Content (track/room/session) seeded.');

  // 5. Session Interaction fixtures: polls + Q&A + a genuinely unrelated event/session.
  // These fixtures exist specifically to eliminate false SKIPs in the adversarial suite.
  const speakerPerson = (await filter('Person', { contact_email: process.env.E2E_SPEAKER_EMAIL || '' }))[0];
  const managerPerson = (await filter('Person', { contact_email: process.env.E2E_MANAGER_EMAIL || '' }))[0];
  const attendee2Email = process.env.E2E_ATTENDEE2_EMAIL || '';
  const attendee2User = await resolveUser(attendee2Email);

  const { rec: pollA } = await getOrCreate('SessionPoll',
    { session_id: (await filter('Session', { event_id: event.id, title: 'E2E Session', is_deleted: false }))[0]?.id || '', question: 'E2E Fixture Poll A', is_deleted: false },
    {
      event_id: event.id, session_id: (await filter('Session', { event_id: event.id, title: 'E2E Session', is_deleted: false }))[0]?.id || '',
      created_by_person_id: speakerPerson?.id || '', question: 'E2E Fixture Poll A', answer_type: 'single_choice',
      max_options: 1, duration_seconds: 300, status: 'draft', voter_count: 0, voted_person_ids: [], is_deleted: false,
    });
  if (pollA) {
    await getOrCreate('SessionPollOption', { poll_id: pollA.id, option_text: 'A', is_deleted: false }, { poll_id: pollA.id, option_text: 'A', position: 0, vote_count: 0, is_deleted: false });
    await getOrCreate('SessionPollOption', { poll_id: pollA.id, option_text: 'B', is_deleted: false }, { poll_id: pollA.id, option_text: 'B', position: 1, vote_count: 0, is_deleted: false });
  }

  const sessionA = (await filter('Session', { event_id: event.id, title: 'E2E Session', is_deleted: false }))[0];
  const participantA = (await filter('Participant', { event_id: event.id, email: process.env.E2E_PARTICIPANT_EMAIL || '', is_deleted: false }))[0];
  await getOrCreate('SessionQuestion',
    { session_id: sessionA?.id || '', question: 'E2E Fixture Public Question', is_deleted: false },
    { event_id: event.id, session_id: sessionA?.id || '', participant_id: participantA?.id || '', person_id: participantA?.person_id || '', question: 'E2E Fixture Public Question', visibility: 'publica', is_answered: false, upvotes: 0, is_deleted: false });
  await getOrCreate('SessionQuestion',
    { session_id: sessionA?.id || '', question: 'E2E Fixture Private Other', is_deleted: false },
    { event_id: event.id, session_id: sessionA?.id || '', participant_id: (await filter('Participant', { event_id: event.id, email: process.env.E2E_MANAGER_EMAIL || '', is_deleted: false }))[0]?.id || '', person_id: managerPerson?.id || '', question: 'E2E Fixture Private Other', visibility: 'particular', is_answered: false, upvotes: 0, is_deleted: false });

  // Event B is deliberately isolated: the speaker persona of A is NOT a member of B.
  // No second persona is required: the B session intentionally has no Participant
  // belonging to the caller from A, which makes the cross-event boundary explicit.
  let eventB = null;
  let sessionB = null;
  const resultB = await getOrCreate('Event',
    { name: `${MARKER}-B`, is_deleted: false },
    { name: `${MARKER}-B`, description: 'Evento B dedicado a testes adversariais cross-event.', start_date: iso(0), end_date: iso(1), location: 'E2E Virtual B', status: 'active', manager_id: managerUser?.id || '', manager_name: managerUser?.full_name || 'E2E Manager', max_participants: 100 });
  eventB = resultB.rec;
  const { rec: trackB } = await getOrCreate('Track', { event_id: eventB?.id || '', name: 'E2E Track B', is_deleted: false }, { event_id: eventB?.id || '', name: 'E2E Track B' });
  const { rec: roomB } = await getOrCreate('Room', { event_id: eventB?.id || '', name: 'E2E Room B', is_deleted: false }, { event_id: eventB?.id || '', name: 'E2E Room B', capacity: 100 });
  sessionB = (await getOrCreate('Session', { event_id: eventB?.id || '', title: 'E2E Session B', is_deleted: false }, { event_id: eventB?.id || '', track_id: trackB?.id || '', room_id: roomB?.id || '', title: 'E2E Session B', description: `${MARKER}-B`, session_type: 'palestra', speaker_id: 'E2E-OTHER-SPEAKER', speaker_name: 'E2E Other Speaker', start_time: iso(0), end_time: iso(0), capacity: 100 })).rec;
  const { rec: pollB } = await getOrCreate('SessionPoll', { session_id: sessionB?.id || '', question: 'E2E Fixture Poll B', is_deleted: false }, { event_id: eventB?.id || '', session_id: sessionB?.id || '', created_by_person_id: 'E2E-OTHER-SPEAKER', question: 'E2E Fixture Poll B', answer_type: 'single_choice', max_options: 1, duration_seconds: 300, status: 'draft', voter_count: 0, voted_person_ids: [], is_deleted: false });
  if (pollB) {
    await getOrCreate('SessionPollOption', { poll_id: pollB.id, option_text: 'A', is_deleted: false }, { poll_id: pollB.id, option_text: 'A', position: 0, vote_count: 0, is_deleted: false });
    await getOrCreate('SessionPollOption', { poll_id: pollB.id, option_text: 'B', is_deleted: false }, { poll_id: pollB.id, option_text: 'B', position: 1, vote_count: 0, is_deleted: false });
  }
  await getOrCreate('SessionQuestion', { session_id: sessionB?.id || '', question: 'E2E Fixture Question B', is_deleted: false }, { event_id: eventB?.id || '', session_id: sessionB?.id || '', participant_id: 'E2E-OTHER-PARTICIPANT', person_id: 'E2E-OTHER-PERSON', question: 'E2E Fixture Question B', visibility: 'publica', is_answered: false, upvotes: 0, is_deleted: false });
  log(`Cross-event fixtures: eventB=${eventB?.id || '-'} sessionB=${sessionB?.id || '-'}`);

  // 6. Gamification + store + certificates + CFP + Award
  await getOrCreate('ScoringRule', { event_id: event.id, acao: 'presenca_sessao', is_deleted: false },
    { event_id: event.id, acao: 'presenca_sessao', pontos: 5, is_active: true });
  await getOrCreate('StoreItem', { event_id: event.id, is_deleted: false },
    { event_id: event.id, description: 'E2E Reward', pontos: 10, estoque: 100, is_active: true });
  await getOrCreate('CertificateTemplate', { event_id: event.id, name: 'E2E Template', is_deleted: false },
    { event_id: event.id, name: 'E2E Template', template_config: '{}' });
  await getOrCreate('CallForPapers', { event_id: event.id, is_deleted: false },
    { event_id: event.id, title: 'E2E CFP', status: 'open', start_date: iso(0), end_date: iso(2), form_config: '[]' });
  await getOrCreate('AwardConfig', { event_id: event.id, title: 'E2E Award', is_deleted: false },
    { event_id: event.id, title: 'E2E Award', start_date: iso(0), end_date: iso(2), form_config: '[]', criteria_config: '[]', assigned_reviewer_ids: '[]' });
  log('Gamification / store / certificates / CFP / award seeded.');

  // 7. Persist state for subsequent runs
  const state = { E2E_EVENT_ID: event.id, E2E_EVENT_B_ID: eventB?.id || '', E2E_SESSION_B_ID: sessionB?.id || '', seeded_at: new Date().toISOString(), base_url: BASE_URL };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log(`Wrote ${path.relative(ROOT, STATE_FILE)}`);
  console.log(`\nE2E_EVENT_ID=${event.id}`);
  log('Done.');
}

main().catch((e) => die(e.message));
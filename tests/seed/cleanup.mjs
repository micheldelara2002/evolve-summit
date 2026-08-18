#!/usr/bin/env node
// =============================================================================
// E2E Cleanup — safely removes the E2E regression dataset from the TEST app.
// =============================================================================
// - Operates ONLY against E2E_BASE_URL (TEST/preview app).
// - Refuses to touch any event whose name !== 'E2E-REGRESSION' (marker guard).
// - Soft-deletes (is_deleted=true) instead of hard-deleting, to be reversible.
// - Never touches production: the marker guard + test-only base URL prevent it.
// - Requires E2E_ADMIN_* to authenticate as admin.
// =============================================================================
import { createClient } from '@base44/sdk';
import { loadE2EEnv, MARKER, PARTNER_TRADE, SEED_TAG, STATE_FILE } from './lib-env.mjs';

loadE2EEnv();

const BASE_URL = process.env.E2E_BASE_URL;
const APP_ID = process.env.BASE44_APP_ID || process.env.VITE_BASE44_APP_ID;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const API_URL = process.env.BASE44_API_URL || '';

const log = (m) => console.log(`[cleanup] ${m}`);
const die = (m) => { console.error(`[cleanup] ✖ ${m}`); process.exit(1); };

if (!BASE_URL || !APP_ID || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
  die('Missing E2E_BASE_URL / BASE44_APP_ID / E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD.');
}

const client = createClient({ appId: APP_ID, token: undefined, serverUrl: API_URL, appBaseUrl: BASE_URL, requiresAuth: true });

async function softDeleteByEvent(entity, eventId) {
  const recs = await client.entities[entity].filter({ event_id: eventId, is_deleted: false }).catch(() => []);
  if (!recs.length) return 0;
  await client.entities[entity].bulkUpdate(recs.map((r) => ({ id: r.id, is_deleted: true }))).catch(() => {});
  return recs.length;
}

async function main() {
  const eventId = process.env.E2E_EVENT_ID;
  if (!eventId) die('E2E_EVENT_ID is required (run bootstrap first, or export it).');

  try { await client.auth.loginViaEmailPassword(ADMIN_EMAIL, ADMIN_PASSWORD); }
  catch (e) { die(`Admin login failed: ${e.message}`); }

  const events = await client.entities.Event.filter({ id: eventId }).catch(() => []);
  const event = events && events[0];
  if (!event) die(`Event ${eventId} not found.`);
  if (event.name !== MARKER) die(`Refusing to clean: event name "${event.name}" !== "${MARKER}". Not an E2E event.`);

  log(`Cleaning E2E event ${eventId} (${event.name}) on ${BASE_URL}`);

  const childEntities = [
    'SessionAttendance', 'SessionFavorite', 'PointTransaction', 'StoreRedemption',
    'SessionQuestion', 'SessionReview', 'Feedback', 'Lead', 'Session', 'Track', 'Room',
    'StoreItem', 'ScoringRule', 'CertificateTemplate', 'Certificate', 'CallForPapers',
    'AwardConfig', 'AwardCategory', 'AwardNomination', 'AwardSubmission', 'AwardEvaluation',
    'NotificationCampaign', 'NotificationRecipient', 'EventPartner', 'EventMembership', 'Participant',
  ];
  for (const e of childEntities) {
    const n = await softDeleteByEvent(e, eventId);
    if (n) log(`${e}: soft-deleted ${n}`);
  }

  // PartnerRepresentative for the E2E partner
  const partner = (await client.entities.Partner.filter({ trade_name: PARTNER_TRADE, is_deleted: false }).catch(() => []))[0];
  if (partner) {
    const reps = await client.entities.PartnerRepresentative.filter({ partner_id: partner.id, is_deleted: false }).catch(() => []);
    if (reps.length) await client.entities.PartnerRepresentative.bulkUpdate(reps.map((r) => ({ id: r.id, is_deleted: true }))).catch(() => {});
    await client.entities.Partner.update(partner.id, { is_deleted: true }).catch(() => {});
    log('E2E Partner + representatives soft-deleted.');
  }

  // E2E People (only those created by bootstrap, by bio/seed marker)
  const people = await client.entities.Person.filter({ bio: MARKER, is_active: true }).catch(() => []);
  if (people.length) {
    await client.entities.Person.bulkUpdate(people.map((p) => ({ id: p.id, is_active: false }))).catch(() => {});
    log(`People deactivated: ${people.length}`);
  }

  // Finally soft-delete the event itself
  await client.entities.Event.update(eventId, { is_deleted: true }).catch(() => {});
  log(`Event ${eventId} soft-deleted.`);
  log('Done. Run bootstrap again to recreate.');
}

main().catch((e) => die(e.message));
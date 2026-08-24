/**
 * Lote RLS — PersonDocument adversarial.
 *
 * Policy:
 *   - admin: full CRUD
 *   - member: only documents whose person_id == authenticated user's person_id
 *   - cross-person reads/writes/deletes: blocked
 *   - ownership/person_id tampering: must not succeed
 *
 * Requires E2E_BASE_URL + admin + participant persona credentials.
 */
import process from 'node:process';
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { createClient } from '@base44/sdk';

const appId = process.env.BASE44_APP_ID || '6a2c618daec1758ff2122225';
const APP_URL = process.env.E2E_BASE_URL || 'https://share--evolve-summit.base44.app';
const baseUrl = APP_URL;

function clientFromState(role) {
  const state = JSON.parse(fs.readFileSync(`tests/.auth/${role}.json`, 'utf8'));
  const origin = state.origins?.find(o => o.origin === APP_URL) || state.origins?.[0];
  const token = origin?.localStorage?.find(x => x.name === 'base44_access_token')?.value || origin?.localStorage?.find(x => x.name === 'token')?.value;
  if (!token) throw new Error(`No auth token in tests/.auth/${role}.json`);
  const client = createClient({ appId, appBaseUrl: APP_URL, requiresAuth: true });
  client.auth.setToken(token, false);
  return client;
}

async function login(email, password) {
  const client = createClient({ appId, appBaseUrl: baseUrl, requiresAuth: true });
  await client.auth.loginViaEmailPassword(email, password);
  return client;
}

test.describe('RLS PersonDocument — adversarial @security @rls @person-document', () => {
  test('PD-1 participant reads only own documents', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const participant = clientFromState('participant');
    const me = await participant.auth.me();
    expect(me.person_id).toBeTruthy();
    const docs = await participant.entities.PersonDocument.filter({});
    expect(docs.every((d) => d.person_id === me.person_id)).toBe(true);
  });

  test('PD-2 participant cannot create document for another person', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const participant = clientFromState('participant');
    const admin = clientFromState('admin');
    const me = await participant.auth.me();
    const people = await admin.entities.Person.filter({ contact_email: process.env.E2E_ADMIN_EMAIL });
    const otherPersonId = people?.[0]?.id;
    test.skip(!otherPersonId || otherPersonId === me.person_id, 'distinct admin person fixture required');
    await expect(participant.entities.PersonDocument.create({
      person_id: otherPersonId,
      country_code: 'BR', document_type: 'E2E', document_number: `RLS-${Date.now()}`,
      is_primary: false, status: 'active',
    })).rejects.toBeTruthy();
  });

  test('PD-3 participant cannot update another person document', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const participant = clientFromState('participant');
    const admin = clientFromState('admin');
    const me = await participant.auth.me();
    const people = await admin.entities.Person.filter({ contact_email: process.env.E2E_ADMIN_EMAIL });
    const otherPersonId = people?.[0]?.id;
    test.skip(!otherPersonId || otherPersonId === me.person_id, 'distinct admin person fixture required');
    const created = await admin.entities.PersonDocument.create({
      person_id: otherPersonId, country_code: 'BR', document_type: 'E2E',
      document_number: `RLS-UPD-${Date.now()}`, is_primary: false, status: 'active',
    });
    try {
      await expect(participant.entities.PersonDocument.update(created.id, { description: 'tampered' })).rejects.toBeTruthy();
    } finally {
      await admin.entities.PersonDocument.delete(created.id);
    }
  });

  test('PD-4 participant cannot delete another person document', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const participant = clientFromState('participant');
    const admin = clientFromState('admin');
    const me = await participant.auth.me();
    const people = await admin.entities.Person.filter({ contact_email: process.env.E2E_ADMIN_EMAIL });
    const otherPersonId = people?.[0]?.id;
    test.skip(!otherPersonId || otherPersonId === me.person_id, 'distinct admin person fixture required');
    const created = await admin.entities.PersonDocument.create({
      person_id: otherPersonId, country_code: 'BR', document_type: 'E2E',
      document_number: `RLS-DEL-${Date.now()}`, is_primary: false, status: 'active',
    });
    try {
      await expect(participant.entities.PersonDocument.delete(created.id)).rejects.toBeTruthy();
    } finally {
      await admin.entities.PersonDocument.delete(created.id);
    }
  });

  test('PD-5 participant cannot reassign ownership of own document to another person', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const participant = clientFromState('participant');
    const admin = clientFromState('admin');
    const me = await participant.auth.me();
    const people = await admin.entities.Person.filter({ contact_email: process.env.E2E_ADMIN_EMAIL });
    const otherPersonId = people?.[0]?.id;
    test.skip(!otherPersonId || otherPersonId === me.person_id, 'distinct admin person fixture required');
    const created = await participant.entities.PersonDocument.create({
      person_id: me.person_id, country_code: 'BR', document_type: 'E2E',
      document_number: `RLS-OWN-${Date.now()}`, is_primary: false, status: 'active',
    });
    try {
      await expect(participant.entities.PersonDocument.update(created.id, { person_id: otherPersonId })).rejects.toBeTruthy();
    } finally {
      await admin.entities.PersonDocument.delete(created.id);
    }
  });

  test('PD-6 admin has full CRUD', async () => {
    test.skip(!baseUrl, 'E2E_BASE_URL required');
    const admin = clientFromState('admin');
    const me = await admin.auth.me();
    expect(me.role).toBe('admin');
    const created = await admin.entities.PersonDocument.create({
      person_id: me.person_id, country_code: 'BR', document_type: 'E2E',
      document_number: `RLS-ADMIN-${Date.now()}`, is_primary: false, status: 'active',
    });
    try {
      const found = await admin.entities.PersonDocument.filter({ id: created.id });
      expect(found).toHaveLength(1);
      await admin.entities.PersonDocument.update(created.id, { description: 'admin-update' });
      const updated = await admin.entities.PersonDocument.filter({ id: created.id });
      expect(updated[0]?.description).toBe('admin-update');
    } finally {
      await admin.entities.PersonDocument.delete(created.id);
    }
  });
});

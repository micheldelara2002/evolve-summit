import { test, expect } from '@playwright/test';
import { createClient } from '@base44/sdk';
import fs from 'node:fs';

const APP_ID = '6a2c618daec1758ff2122225';
const APP_URL = 'https://share--evolve-summit.base44.app';
const EVENT_A = '6a84a75d4d0b7d531fd91dd0';
const EVENT_B = '6a829bfb79832f1efececa3e';
const ENTITIES = ['AwardConfig', 'CallForPapers'];

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

function expectRejected(promise, label) {
  return expect(promise, label).rejects.toBeTruthy();
}

test.describe('RLS AwardConfig + CallForPapers @security', () => {
  test('direct SDK read is blocked for non-admin personas', async () => {
    for (const role of ['participant', 'speaker', 'manager', 'partner']) {
      const client = clientFromState(role);
      for (const entityName of ENTITIES) {
        const records = await client.entities[entityName].list();
        expect(records, `${role} direct ${entityName} read must expose no records`).toHaveLength(0);
      }
    }
  });

  test('manager can CRUD each entity through the function only inside its event', async () => {
    const manager = clientFromState('manager');
    const marker = `E2E-RLS-${Date.now()}`;
    const created = [];

    const fixtures = {
      AwardConfig: {
        title: `${marker} Award`,
        description: 'E2E security fixture',
        start_date: '2026-08-21T10:00:00.000Z',
        end_date: '2026-08-31T22:00:00.000Z',
        form_config: '[]',
        criteria_config: '[{"id":"c1","label":"Quality","weight":100,"max_score":10}]',
        assigned_reviewer_ids: '[]',
        is_active: true,
      },
      CallForPapers: {
        title: `${marker} CFP`,
        description: 'E2E security fixture',
        start_date: '2026-08-21T10:00:00.000Z',
        end_date: '2026-08-31T22:00:00.000Z',
        form_config: '[]',
        is_active: true,
      },
    };

    try {
      for (const entityName of ENTITIES) {
        const createdResponse = await invoke(manager, {
          action: 'create', entityName, eventId: EVENT_A, data: fixtures[entityName],
        });
        expect(createdResponse.status, `${entityName} create`).toBe(200);
        const record = createdResponse.data?.record;
        expect(record?.event_id, `${entityName} event isolation`).toBe(EVENT_A);
        created.push([entityName, record.id]);

        const listed = await invoke(manager, { action: 'list', entityName, eventId: EVENT_A });
        expect(listed.status, `${entityName} list`).toBe(200);
        expect((listed.data?.records || []).some(r => r.id === record.id)).toBeTruthy();

        const updateData = entityName === 'AwardConfig'
          ? { description: `${marker}-updated` }
          : { description: `${marker}-updated` };
        const updated = await invoke(manager, {
          action: 'update', entityName, eventId: EVENT_A, id: record.id, data: updateData,
        });
        expect(updated.status, `${entityName} update`).toBe(200);

        // AwardConfig/CallForPapers are intentionally public-read configurations:
        // list without eventId is global over active records. Cross-event isolation is
        // therefore asserted on mutations, not on public reads.
        const crossEventUpdate = await invoke(manager, {
          action: 'update', entityName, eventId: EVENT_B, id: record.id, data: { description: `${marker}-cross-event` },
        }).catch(() => null);
        expect(crossEventUpdate, `${entityName} cross-event update must not mutate own-event record`).toBeNull();
        const crossEventCreate = await invoke(manager, {
          action: 'create', entityName, eventId: EVENT_B, data: fixtures[entityName],
        }).catch(() => null);
        expect(crossEventCreate, `${entityName} cross-event create must be rejected`).toBeNull();
      }
    } finally {
      for (const [entityName, id] of created) {
        try {
          await invoke(manager, { action: 'delete', entityName, eventId: EVENT_A, id });
        } catch {}
      }
    }
  });

  test('participant and speaker can read active configs through the function, without sensitive AwardConfig fields', async () => {
    const manager = clientFromState('manager');
    const participant = clientFromState('participant');
    const speaker = clientFromState('speaker');
    const marker = `E2E-RLS-PUBLIC-${Date.now()}`;
    const created = [];

    try {
      for (const entityName of ENTITIES) {
        const data = entityName === 'AwardConfig'
          ? {
              title: `${marker} Award`, description: 'E2E public fixture',
              start_date: '2026-08-21T10:00:00.000Z', end_date: '2026-08-31T22:00:00.000Z',
              form_config: '[]', criteria_config: '[{"id":"secret"}]', assigned_reviewer_ids: '["secret-user"]', is_active: true,
            }
          : {
              title: `${marker} CFP`, description: 'E2E public fixture',
              start_date: '2026-08-21T10:00:00.000Z', end_date: '2026-08-31T22:00:00.000Z',
              form_config: '[]', is_active: true,
            };

        const createdResponse = await invoke(manager, { action: 'create', entityName, eventId: EVENT_A, data });
        expect(createdResponse.status).toBe(200);
        const id = createdResponse.data.record.id;
        created.push([entityName, id]);

        const [participantResponse, speakerResponse] = await Promise.all([
          invoke(participant, { action: 'list', entityName }),
          invoke(speaker, { action: 'list', entityName }),
        ]);
        for (const [role, response] of [['participant', participantResponse], ['speaker', speakerResponse]]) {
          expect(response.status, `${role} ${entityName} public read`).toBe(200);
          const record = (response.data?.records || []).find(r => r.id === id);
          expect(record, `${role} can see active ${entityName}`).toBeTruthy();
          expect(record.is_deleted).toBeUndefined();
          if (entityName === 'AwardConfig') {
            expect(record.criteria_config).toBeUndefined();
            expect(record.assigned_reviewer_ids).toBeUndefined();
          }
        }
      }
    } finally {
      for (const [entityName, id] of created) {
        try {
          await invoke(manager, { action: 'delete', entityName, eventId: EVENT_A, id });
        } catch {}
      }
    }
  });

  test('non-admin direct writes remain blocked by RLS', async () => {
    for (const role of ['participant', 'speaker', 'manager', 'partner']) {
      const client = clientFromState(role);
      for (const entityName of ENTITIES) {
        const payload = entityName === 'AwardConfig'
          ? { event_id: EVENT_A, title: `DIRECT-${Date.now()}`, start_date: '2026-08-21T10:00:00.000Z', end_date: '2026-08-31T22:00:00.000Z' }
          : { event_id: EVENT_A, title: `DIRECT-${Date.now()}`, start_date: '2026-08-21T10:00:00.000Z', end_date: '2026-08-31T22:00:00.000Z' };
        await expectRejected(
          client.entities[entityName].create(payload),
          `${role} direct ${entityName} create must be rejected`,
        );
      }
    }
  });
});

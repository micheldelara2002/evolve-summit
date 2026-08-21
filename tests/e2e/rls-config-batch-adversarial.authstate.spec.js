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

async function invoke(client, payload) {
  return client.functions.invoke('manageEventConfig', payload);
}

const ENTITIES = ['Badge', 'StoreItem', 'ScoringRule', 'CertificateTemplate'];

test.describe('RLS config batch — Badge/StoreItem/ScoringRule/CertificateTemplate @security', () => {
  test('direct SDK access is blocked for non-admin personas', async () => {
    for (const role of ['participant', 'speaker', 'manager', 'partner']) {
      const c = clientFromState(role);
      for (const entityName of ENTITIES) {
        const records = await c.entities[entityName].list();
        expect(records, `${role} direct ${entityName} read must expose no records`).toHaveLength(0);
      }
    }
  });

  test('manager function can CRUD only inside its event', async () => {
    const manager = clientFromState('manager');
    const marker = `E2E-RLS-${Date.now()}`;
    const createdIds = [];

    const fixtures = {
      Badge: { codigo: marker, titulo: 'E2E RLS Badge', categoria: 'engajamento', coluna_progresso: 'partindo', criterio_tipo: 'first', valor_meta: 1, ativo: true },
      StoreItem: { codigo_item: marker, descricao_item: 'E2E RLS Store Item', pontos_necessarios: 100, estoque_total: 1, limite_por_usuario: 1, status: 'ativo' },
      ScoringRule: { acao: 'presenca_sessao', pontos: 100, ativo: true, limite_tipo: 'por_sessao', limite_valor: 1 },
      CertificateTemplate: { name: marker, tipo: 'participacao', background_url: 'https://e2e.invalid/template.png', is_active: true },
    };

    try {
      for (const entityName of ENTITIES) {
        const created = await invoke(manager, { action: 'create', entityName, eventId: EVENT_A, data: fixtures[entityName] });
        expect(created.status, `${entityName} create`).toBe(200);
        expect(created.data?.record?.event_id, `${entityName} event isolation`).toBe(EVENT_A);
        createdIds.push([entityName, created.data.record.id]);

        const listed = await invoke(manager, { action: 'list', entityName, eventId: EVENT_A });
        expect(listed.status, `${entityName} list`).toBe(200);
        expect((listed.data?.records || []).some(r => r.id === created.data.record.id)).toBeTruthy();

        const updated = await invoke(manager, { action: 'update', entityName, eventId: EVENT_A, id: created.data.record.id, data: entityName === 'Badge' ? { titulo: `${marker}-updated` } : entityName === 'StoreItem' ? { descricao_item: `${marker}-updated` } : entityName === 'ScoringRule' ? { pontos: 200 } : { name: `${marker}-updated` } });
        expect(updated.status, `${entityName} update`).toBe(200);
      }

      for (const entityName of ENTITIES) {
        await expect(invoke(manager, { action: 'list', entityName, eventId: EVENT_B })).rejects.toBeTruthy();
      }
    } finally {
      for (const [entityName, id] of createdIds) {
        try { await invoke(manager, { action: 'delete', entityName, eventId: EVENT_A, id }); } catch {}
      }
    }
  });

  test('participant/speaker can read only active Badge and StoreItem through the function', async () => {
    const manager = clientFromState('manager');
    const participant = clientFromState('participant');
    const speaker = clientFromState('speaker');
    const marker = `E2E-RLS-PUBLIC-${Date.now()}`;
    const createdIds = [];

    try {
      for (const entityName of ['Badge', 'StoreItem']) {
        const data = entityName === 'Badge'
          ? { codigo: marker, titulo: 'E2E public badge', categoria: 'engajamento', coluna_progresso: 'partindo', criterio_tipo: 'first', valor_meta: 1, ativo: true }
          : { codigo_item: marker, descricao_item: 'E2E public store item', pontos_necessarios: 100, estoque_total: 1, limite_por_usuario: 1, status: 'ativo' };
        const created = await invoke(manager, { action: 'create', entityName, eventId: EVENT_A, data });
        expect(created.status).toBe(200);
        createdIds.push([entityName, created.data.record.id]);

        const [p, s] = await Promise.all([
          invoke(participant, { action: 'list', entityName, eventId: EVENT_A }),
          invoke(speaker, { action: 'list', entityName, eventId: EVENT_A }),
        ]);
        expect(p.status, `participant ${entityName}`).toBe(200);
        expect(s.status, `speaker ${entityName}`).toBe(200);
        expect((p.data?.records || []).some(r => r.id === created.data.record.id)).toBeTruthy();
        expect((s.data?.records || []).some(r => r.id === created.data.record.id)).toBeTruthy();
      }

      for (const entityName of ['Badge', 'StoreItem']) {
        await expect(invoke(participant, { action: 'list', entityName, eventId: EVENT_B })).rejects.toBeTruthy();
      }
    } finally {
      for (const [entityName, id] of createdIds) {
        try { await invoke(manager, { action: 'delete', entityName, eventId: EVENT_A, id }); } catch {}
      }
    }
  });
});

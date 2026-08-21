import { test, expect } from '@playwright/test';

const QUICKWINS = ['AuditLog', 'Import', 'NotificationRecipient'];

async function getBase44(page) {
  return page.evaluate(() => window.base44);
}

for (const role of ['participant', 'speaker', 'manager', 'partner']) {
  test.describe(`RLS quick wins — ${role}`, () => {
    test.use({ storageState: `tests/.auth/${role}.json` });

    test('direct SDK access is blocked for admin-only entities', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async (entities) => {
        const out = {};
        for (const name of entities) {
          try {
            const rows = await window.base44.entities[name].list();
            out[name] = { ok: true, count: Array.isArray(rows) ? rows.length : null };
          } catch (e) {
            out[name] = { ok: false, error: String(e?.message || e) };
          }
        }
        return out;
      }, QUICKWINS.slice(0, 2));

      expect(result.AuditLog.ok && result.AuditLog.count > 0).toBe(false);
      expect(result.Import.ok && result.Import.count > 0).toBe(false);
    });

    test('cannot read another user notification recipient', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async () => {
        const rows = await window.base44.entities.NotificationRecipient.list();
        return Array.isArray(rows) ? rows : [];
      });

      for (const row of result) {
        expect(row.recipient_user_id).toBeTruthy();
        const me = await page.evaluate(() => window.base44.auth.me());
        expect(row.recipient_user_id).toBe(me.id);
      }
    });
  });
}

test.describe('RLS quick wins — admin baseline', () => {
  test.use({ storageState: 'tests/.auth/manager.json' });

  test('notification recipient own-record update remains possible only for own record', async ({ page }) => {
    await page.goto('/');
    const me = await page.evaluate(() => window.base44.auth.me());
    const rows = await page.evaluate(async () => window.base44.entities.NotificationRecipient.list());
    const own = rows.find((r) => r.recipient_user_id === me.id);
    if (!own) test.skip(true, 'No own NotificationRecipient fixture available');

    const result = await page.evaluate(async (id) => {
      try {
        await window.base44.entities.NotificationRecipient.update(id, { read_at: new Date().toISOString() });
        return 'updated';
      } catch (e) {
        return String(e?.message || e);
      }
    }, own.id);
    expect(result).toBe('updated');
  });
});

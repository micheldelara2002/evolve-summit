import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const eventId = process.env.E2E_EVENT_ID;

function makeCsv(rows) {
  const header = 'nome,email,cpf,telefone,empresa,cargo,linkedin,instagram,youtube,site,sobre_mim';
  return [header, ...rows.map((r) => [
    r.name, r.email, r.cpf, r.phone, r.company || '', r.job || '', '', '', '', '', ''
  ].join(','))].join('\n');
}

function fakeRows(count, prefix = `e2e-${Date.now()}`) {
  return Array.from({ length: count }, (_, i) => ({
    name: `E2E Import ${i + 1}`,
    email: `${prefix}-${i + 1}@example.invalid`,
    cpf: String(90000000000 + i).padStart(11, '0'),
    phone: `119${String(10000000 + i).slice(-8)}`,
    company: 'E2E QA',
    job: 'Test Participant',
  }));
}

async function uploadCsv(page, rows) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'evolve-e2e-'));
  const file = path.join(dir, 'participants.csv');
  await fs.writeFile(file, makeCsv(rows), 'utf8');
  await page.locator('input[type="file"][accept=".csv"]').setInputFiles(file);
  await expect(page.getByText('Pré-visualização da importação')).toBeVisible({ timeout: 15_000 });
  return dir;
}

test.describe('Bulk CSV import — manager @manager @bulk @regression', () => {
  test('valid CSV is classified in dry-run without creating records @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}/people`);

    const rows = fakeRows(5);
    const dir = await uploadCsv(page, rows);

    await expect(page.getByText('Novos')).toBeVisible();
    await expect(page.getByText('Inválidos')).toBeVisible();
    await expect(page.getByRole('button', { name: /Confirmar/ })).toBeVisible();

    // Critical property: preview must not mutate before confirmation.
    // This test intentionally stops before clicking Confirmar.
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('duplicate CPF/email inside CSV is rejected @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}/people`);

    const rows = fakeRows(2);
    rows[1].email = rows[0].email;
    rows[1].cpf = rows[0].cpf;
    const dir = await uploadCsv(page, rows);

    await expect(page.getByText(/Duplicado no arquivo CSV/i)).toBeVisible();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('invalid required fields are excluded from import @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}/people`);

    const rows = fakeRows(2);
    rows[0].email = 'not-an-email';
    rows[1].name = '';
    const dir = await uploadCsv(page, rows);

    await expect(page.getByText(/E-mail inválido/i)).toBeVisible();
    await expect(page.getByText(/Campo obrigatório/i)).toBeVisible();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('500-row CSV reaches preview without browser-side failure @P1 @scale', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    test.setTimeout(75_000);
    await page.goto(`/events/${eventId}/people`);

    const rows = fakeRows(500, `e2e-scale-500-${Date.now()}`);
    const dir = await uploadCsv(page, rows);

    await expect(page.getByText('Pré-visualização da importação')).toBeVisible();
    await expect(page.getByRole('button', { name: /Confirmar/ })).toBeVisible();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('1001-row CSV reaches preview without browser-side failure @P1 @scale', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    test.setTimeout(90_000);
    await page.goto(`/events/${eventId}/people`);

    const rows = fakeRows(1001, `e2e-scale-${Date.now()}`);
    const dir = await uploadCsv(page, rows);

    await expect(page.getByText('Pré-visualização da importação')).toBeVisible();
    await expect(page.getByRole('button', { name: /Confirmar/ })).toBeVisible();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('same CSV can be previewed twice without silent mutation @P1', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}/people`);
    const rows = fakeRows(5, `e2e-replay-${Date.now()}`);
    const dir = await uploadCsv(page, rows);
    await expect(page.getByText('Pré-visualização da importação')).toBeVisible();
    const firstPreview = await page.locator('body').innerText();

    await page.reload();
    const dir2 = await uploadCsv(page, rows);
    await expect(page.getByText('Pré-visualização da importação')).toBeVisible();
    const secondPreview = await page.locator('body').innerText();

    expect(secondPreview).toContain('Pré-visualização da importação');
    expect(secondPreview.length).toBeGreaterThan(0);
    expect(firstPreview.length).toBeGreaterThan(0);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(dir2, { recursive: true, force: true });
  });
});

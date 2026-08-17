import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const roles = [
  ['manager', 'E2E_MANAGER_EMAIL', 'E2E_MANAGER_PASSWORD'],
  ['staff', 'E2E_STAFF_EMAIL', 'E2E_STAFF_PASSWORD'],
  ['participant', 'E2E_PARTICIPANT_EMAIL', 'E2E_PARTICIPANT_PASSWORD'],
  ['speaker', 'E2E_SPEAKER_EMAIL', 'E2E_SPEAKER_PASSWORD'],
  ['partner', 'E2E_PARTNER_EMAIL', 'E2E_PARTNER_PASSWORD'],
];

for (const [role, emailKey, passwordKey] of roles) {
  setup(`authenticate ${role}`, async ({ page }) => {
    const email = process.env[emailKey];
    const password = process.env[passwordKey];
    testFailIfMissing(emailKey, email);
    testFailIfMissing(passwordKey, password);

    await page.goto('/login');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
    await fs.mkdir(path.resolve('tests/.auth'), { recursive: true });
    await page.context().storageState({ path: path.resolve(`tests/.auth/${role}.json`) });
  });
}

function testFailIfMissing(key, value) {
  if (!value) throw new Error(`Missing required E2E environment variable: ${key}`);
}

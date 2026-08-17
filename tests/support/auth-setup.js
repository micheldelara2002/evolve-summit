import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

export function createAuthSetup(role, emailKey, passwordKey) {
  return async ({ page }) => {
    const email = process.env[emailKey];
    const password = process.env[passwordKey];

    if (!email || !password) {
      throw new Error(`Missing ${emailKey} or ${passwordKey}. Configure the ${role} test account in the test environment.`);
    }

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel('Senha').fill(password);
    await page.getByRole('button', { name: 'Entrar' }).click();

    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });

    const authDir = path.resolve('tests/.auth');
    await fs.mkdir(authDir, { recursive: true });
    await page.context().storageState({ path: path.join(authDir, `${role}.json`) });
  };
}

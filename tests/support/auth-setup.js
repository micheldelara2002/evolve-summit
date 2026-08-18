import { expect } from '@playwright/test';
import { createClient } from '@base44/sdk';
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

    // Test-fixture repair: some manually-created regression users can exist
    // without the User.person_id link even though their Person record exists.
    // The application relies on that link for the full profile/deletion UI.
    // Repair only the currently authenticated persona, never another user.
    const appId = process.env.BASE44_APP_ID || process.env.VITE_BASE44_APP_ID || '6a2c618daec1758ff2122225';
    const sdk = createClient({ appId, appBaseUrl: process.env.E2E_BASE_URL || page.url().split('/login')[0], requiresAuth: true });
    await sdk.auth.loginViaEmailPassword(email, password);
    const currentUser = await sdk.auth.me();
    if (!currentUser?.person_id) {
      const persons = await sdk.entities.Person.filter({ contact_email: email });
      if (persons?.[0]?.id) {
        await sdk.auth.updateMe({ person_id: persons[0].id });
      }
    }

    const authDir = path.resolve('tests/.auth');
    await fs.mkdir(authDir, { recursive: true });
    await page.context().storageState({ path: path.join(authDir, `${role}.json`) });
  };
}

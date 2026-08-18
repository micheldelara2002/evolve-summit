# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth-partner.setup.js >> authenticate partner
- Location: tests/e2e/auth-partner.setup.js:3:1

# Error details

```
Error: Missing E2E_PARTNER_EMAIL or E2E_PARTNER_PASSWORD. Configure the partner test account in the test environment.
```

# Test source

```ts
  1  | import { expect } from '@playwright/test';
  2  | import fs from 'node:fs/promises';
  3  | import path from 'node:path';
  4  | 
  5  | export function createAuthSetup(role, emailKey, passwordKey) {
  6  |   return async ({ page }) => {
  7  |     const email = process.env[emailKey];
  8  |     const password = process.env[passwordKey];
  9  | 
  10 |     if (!email || !password) {
> 11 |       throw new Error(`Missing ${emailKey} or ${passwordKey}. Configure the ${role} test account in the test environment.`);
     |             ^ Error: Missing E2E_PARTNER_EMAIL or E2E_PARTNER_PASSWORD. Configure the partner test account in the test environment.
  12 |     }
  13 | 
  14 |     await page.goto('/login', { waitUntil: 'domcontentloaded' });
  15 |     await page.getByLabel('E-mail').fill(email);
  16 |     await page.getByLabel('Senha').fill(password);
  17 |     await page.getByRole('button', { name: 'Entrar' }).click();
  18 | 
  19 |     await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
  20 | 
  21 |     const authDir = path.resolve('tests/.auth');
  22 |     await fs.mkdir(authDir, { recursive: true });
  23 |     await page.context().storageState({ path: path.join(authDir, `${role}.json`) });
  24 |   };
  25 | }
  26 | 
```
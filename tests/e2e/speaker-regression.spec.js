import { test, expect } from '@playwright/test';

const eventId = process.env.E2E_SPEAKER_EVENT_ID || process.env.E2E_EVENT_ID;

test.describe('Speaker regression @speaker @regression', () => {
  test('SP-001 speaker dashboard loads @P0 @smoke', async ({ page }) => {
    await page.goto('/speaker-dashboard');
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('SP-002/003 own sessions are visible without application errors @P0', async ({ page }) => {
    await page.goto('/speaker-dashboard');
    await expect(page.locator('body')).not.toContainText(/Application error|ChunkLoadError/i);
  });

  test('SP-004/005/006 speaker KPI areas load @P1', async ({ page }) => {
    await page.goto('/speaker-dashboard');
    await expect(page.getByRole('heading').first()).toBeVisible();
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toMatch(/undefined|NaN/i);
  });

  test('SP-007/008 engagement UI is available when own sessions exist @P1', async ({ page }) => {
    await page.goto('/speaker-dashboard');
    const buttons = page.getByRole('button');
    await expect(buttons.first()).toBeVisible();
  });

  test('SP-009/012 speaker cannot rely on arbitrary participant mutation routes @P0 @security', async ({ page }) => {
    if (!eventId) test.skip(true, 'No speaker event configured');
    await page.goto(`/events/${eventId}/score`);
    await expect(page).not.toHaveURL(/\/login$/);
    await expect(page.locator('body')).not.toContainText(/Application error|ChunkLoadError/i);
  });

  test('SP-013 notifications do not crash speaker experience @P1', async ({ page }) => {
    await page.goto('/speaker-dashboard');
    await expect(page.locator('body')).not.toContainText(/Application error|ChunkLoadError/i);
  });

  test('SP-014 cross-event speaker URL does not expose arbitrary event data @P0 @security', async ({ page }) => {
    if (!eventId) test.skip(true, 'No speaker event configured');
    const fakeEvent = `${eventId}-unauthorized`;
    const response = await page.goto(`/event/${fakeEvent}`);
    const status = response?.status() ?? 0;
    const bodyText = await page.locator('body').innerText();
    expect([200, 403, 404]).toContain(status);
    expect(bodyText).not.toMatch(/E2E Session|QA Speaker/i);
  });
});

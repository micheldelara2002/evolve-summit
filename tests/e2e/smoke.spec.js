import { test, expect } from '@playwright/test';

const eventId = process.env.E2E_EVENT_ID;

test.describe('Release smoke @regression @smoke', () => {
  test('authenticated shell loads @P0 @manager @staff @participant @speaker @partner', async ({ page }) => {
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/login$/);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('profile loads @P0', async ({ page }) => {
    await page.goto('/profile');
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('primary navigation routes are healthy @P0', async ({ page }) => {
    for (const route of ['/', '/my-events', '/network', '/qr-scan', '/profile']) {
      await page.goto(route);
      await expect(page.locator('body')).not.toContainText(/Application error|ChunkLoadError|Internal Server Error/i);
      await expect(page.getByRole('heading').first()).toBeVisible();
    }
  });

  test('regression event shell loads @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/event/${eventId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('admin event shell loads for manager @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
});

import { test, expect } from '@playwright/test';

const eventId = process.env.E2E_EVENT_ID;

async function healthy(page) {
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.locator('body')).not.toContainText(/Application error|ChunkLoadError|Internal Server Error/i);
  await expect(page.getByRole('heading').first()).toBeVisible();
}

test.describe('Release smoke @regression @smoke', () => {
  test('manager smoke: authenticated shell and event management @manager @P0', async ({ page }) => {
    await page.goto('/');
    await healthy(page);
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}`);
    await healthy(page);
  });

  test('staff smoke: authenticated shell and event @staff @P0', async ({ page }) => {
    await page.goto('/');
    await healthy(page);
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/event/${eventId}`);
    await healthy(page);
  });

  test('participant smoke: home, events and profile @participant @P0', async ({ page }) => {
    await page.goto('/');
    await healthy(page);
    await page.goto('/my-events');
    await healthy(page);
    await page.goto('/profile');
    await healthy(page);
  });

  test('speaker smoke: dashboard @speaker @P0', async ({ page }) => {
    await page.goto('/speaker-dashboard');
    await healthy(page);
  });

  test('partner smoke: dashboard @partner @P0', async ({ page }) => {
    await page.goto('/partner-dashboard');
    await healthy(page);
  });
});

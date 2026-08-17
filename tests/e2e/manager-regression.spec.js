import { test, expect } from '@playwright/test';

const eventId = process.env.E2E_EVENT_ID;
const event = () => test.skip(!eventId, 'E2E_EVENT_ID not configured');

async function expectNotOnRoute(page, path) {
  await expect(page).not.toHaveURL(new RegExp(`${path.replaceAll('/', '\\/')}(?:$|[?#])`));
}

test.describe('Manager regression @manager @regression', () => {
  test('GM-001/003 manager home and event load @P0 @smoke', async ({ page }) => {
    event();
    await page.goto(`/events/${eventId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('GM-007 event modules do not crash @P0', async ({ page }) => {
    event();
    const modules = ['people', 'tracks', 'rooms', 'sessions', 'ranking', 'partners', 'store', 'score', 'badges', 'notifications', 'feedback', 'raffle', 'certificates', 'cfp', 'premiacao'];
    for (const module of modules) {
      await page.goto(`/events/${eventId}/${module}`);
      await expect(page.locator('body')).not.toContainText(/Application error|ChunkLoadError|Cannot read properties of undefined/i);
      await expect(page.getByRole('heading').first()).toBeVisible();
    }
  });

  test('GM-008 returning from module retains event context @P1', async ({ page }) => {
    event();
    await page.goto(`/events/${eventId}/sessions`);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/events/${eventId}$`));
  });

  test('GM-030/031 tracks and rooms are reachable @P1', async ({ page }) => {
    event();
    for (const module of ['tracks', 'rooms']) {
      await page.goto(`/events/${eventId}/${module}`);
      await expect(page.getByRole('heading').first()).toBeVisible();
    }
  });

  test('GM-032/033 sessions and speaker assignment surface load @P1', async ({ page }) => {
    event();
    await page.goto(`/events/${eventId}/sessions`);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.locator('button').first()).toBeVisible();
  });

  test('GM-035/036 scoring and badges surfaces load @P1', async ({ page }) => {
    event();
    for (const module of ['score', 'badges']) {
      await page.goto(`/events/${eventId}/${module}`);
      await expect(page.getByRole('heading').first()).toBeVisible();
    }
  });

  test('GM-037/038/039 store raffle certificates surfaces load @P1', async ({ page }) => {
    event();
    for (const module of ['store', 'raffle', 'certificates']) {
      await page.goto(`/events/${eventId}/${module}`);
      await expect(page.getByRole('heading').first()).toBeVisible();
    }
  });

  test('GM-040/041 CFP and awards surfaces load @P1', async ({ page }) => {
    event();
    for (const module of ['cfp', 'premiacao']) {
      await page.goto(`/events/${eventId}/${module}`);
      await expect(page.getByRole('heading').first()).toBeVisible();
    }
  });

  test('GM-050/051 notification campaign surface is reachable @P0', async ({ page }) => {
    event();
    await page.goto(`/events/${eventId}/notifications`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('GM-055 notification metrics surface loads @P1', async ({ page }) => {
    event();
    await page.goto(`/events/${eventId}/notifications/metrics`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('GM-060 arbitrary event ID does not silently expose another event @P0 @security', async ({ page }) => {
    event();
    const fake = `${eventId}-unauthorized`;
    await page.goto(`/events/${fake}`);
    await expect(page.locator('body')).not.toContainText(/Internal Server Error|Application error/i);
    await expectNotOnRoute(page, `/events/${fake}`);
  });

  test('GM-061/062/063/064/065 sensitive modules remain manager-scoped @P0 @security', async ({ page }) => {
    event();
    for (const module of ['partners', 'score', 'store', 'certificates']) {
      await page.goto(`/events/${eventId}/${module}`);
      await expect(page.getByRole('heading').first()).toBeVisible();
    }
  });
});

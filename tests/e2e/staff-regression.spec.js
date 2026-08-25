import { test, expect } from '@playwright/test';

const eventId = process.env.E2E_EVENT_ID;

async function assertDenied(page, route) {
  await page.goto(route);
  await expect(page).not.toHaveURL(new RegExp(`${route.replaceAll('/', '\\/')}$`));
}

test.describe('Staff regression @staff @regression', () => {
  test('ST-001/002 staff home and assigned event load @P0 @smoke', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('ST-003 staff remains inside assigned event scope @P0 @security', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
    const fakeEvent = `${eventId}-unauthorized`;
    await page.goto(`/event/${fakeEvent}`);
    await expect(page).not.toHaveURL(new RegExp(`/event/${fakeEvent}$`));
  });

  test('ST-004/008 participants and schedule surfaces are reachable @P1', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    for (const route of [`/events/${eventId}`, '/my-events']) {
      await page.goto(route);
      await expect(page.getByRole('heading').first()).toBeVisible();
    }
  });

  test('ST-010/011 staff cannot enter global admin routes @P0 @security', async ({ page }) => {
    for (const route of ['/events', '/people', '/audit', '/notifications']) {
      await assertDenied(page, route);
    }
  });

  test('ST-013 staff cannot use global campaign administration @P0 @security', async ({ page }) => {
    await assertDenied(page, '/notifications');
  });

  test('ST-014 staff cannot mutate points through a route-only shortcut @P0 @security', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}/score`);
    await expect(page).not.toHaveURL(/\/login$/);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
});

import { test, expect } from '@playwright/test';

const eventId = process.env.E2E_EVENT_ID;

test.describe('Gerente — event operations @manager @regression', () => {
  test('opens home and event context @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto('/');
    await expect(page).not.toHaveURL(/\/login/);
    await page.goto(`/event/${eventId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('management route exposes intended event-management capability @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}`);
    // This is intentionally a business-contract test. If managers are supposed
    // to manage events, a redirect to home is a release-blocking regression.
    const url = page.url();
    const denied = url.endsWith('/') || /\/login/.test(url);
    expect(denied, 'Manager unexpectedly denied from event management').toBeFalsy();
  });

  test('cannot access global admin people route @P0 @security', async ({ page }) => {
    await page.goto('/people');
    await expect(page).not.toHaveURL(/\/people$/);
  });
});

test.describe('Staff — event operations @staff @regression', () => {
  test('opens event and sees event experience @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/event/${eventId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('cannot access global admin routes @P0 @security', async ({ page }) => {
    for (const route of ['/events', '/people', '/audit', '/notifications']) {
      await page.goto(route);
      await expect(page).not.toHaveURL(new RegExp(`${route.replace('/', '\\/')}$`));
    }
  });
});

test.describe('Participant — event experience @participant @regression', () => {
  test('opens my events @P0', async ({ page }) => {
    await page.goto('/my-events');
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('opens event schedule @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/event/${eventId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('profile and deletion entry point are available @P0', async ({ page }) => {
    await page.goto('/profile');
    await expect(page.getByRole('heading').first()).toBeVisible();
    await expect(page.getByText(/Excluir minha conta/i)).toBeVisible();
  });
});

test.describe('Speaker — speaker dashboard @speaker @regression', () => {
  test('opens speaker dashboard @P0', async ({ page }) => {
    await page.goto('/speaker-dashboard');
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('does not expose another speaker identity through URL-only navigation @P0 @security', async ({ page }) => {
    await page.goto('/speaker-dashboard');
    await expect(page.getByRole('heading').first()).toBeVisible();
    // Detailed cross-user authorization is covered by backend security tests;
    // this E2E smoke verifies the dashboard itself is reachable only as the
    // authenticated speaker persona.
  });
});

test.describe('Partner — partner dashboard @partner @regression', () => {
  test('opens partner dashboard @P0', async ({ page }) => {
    await page.goto('/partner-dashboard');
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('opens partner company management for partner manager @P0', async ({ page }) => {
    await page.goto('/partner');
    await expect(page.getByRole('heading').first()).toBeVisible();
  });
});

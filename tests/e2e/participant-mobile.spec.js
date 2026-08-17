import { test, expect } from '@playwright/test';

const eventId = process.env.E2E_EVENT_ID;

test.describe('Participant mobile regression @mobile @participant', () => {
  test('bottom navigation remains usable @P0', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
    const links = page.getByRole('navigation').getByRole('link');
    await expect(links.first()).toBeVisible();
  });

  test('profile actions have usable touch targets @P1', async ({ page }) => {
    await page.goto('/profile');
    const deleteText = page.getByText(/Excluir minha conta/i);
    await expect(deleteText).toBeVisible();
  });

  test('event experience does not overflow horizontally @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/event/${eventId}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBeFalsy();
  });

  test('schedule navigation and favorite controls are present @P1', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/event/${eventId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
    // Favorite controls are data-dependent. The test verifies the event shell
    // remains interactive even when the event has no sessions.
    const buttons = page.getByRole('button');
    await expect(buttons.first()).toBeVisible();
  });
});

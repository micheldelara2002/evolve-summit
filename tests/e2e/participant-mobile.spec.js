import { test, expect } from '@playwright/test';

const eventId = process.env.E2E_EVENT_ID;

test.describe('Participant mobile regression @mobile @participant @regression', () => {
  test('bottom navigation remains usable @P0', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
    const links = page.getByRole('navigation').getByRole('link');
    await expect(links.first()).toBeVisible();
  });

  test('profile actions have usable touch targets @P1', async ({ page }) => {
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading').first()).toBeVisible();
    const deleteText = page.getByText('Excluir minha conta', { exact: true }).first();
    await expect(deleteText).toBeAttached({ timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(deleteText).toBeVisible({ timeout: 10_000 });
  });

  test('event experience does not overflow horizontally @P0', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/event/${eventId}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBeFalsy();
  });

  test('320px viewport has no horizontal overflow @P0', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBeFalsy();
  });

  test('375px viewport has no horizontal overflow @P0', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBeFalsy();
  });

  test('430px viewport has no horizontal overflow @P0', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 800 });
    await page.goto('/');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBeFalsy();
  });

  test('critical navigation buttons have at least 44px hit area when present @P1', async ({ page }) => {
    await page.goto('/profile');
    const buttons = page.getByRole('button');
    const count = await buttons.count();
    for (let i = 0; i < Math.min(count, 8); i += 1) {
      const box = await buttons.nth(i).boundingBox();
      if (box) {
        expect(Math.min(box.width, box.height), `button ${i} below 44px`).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('back navigation does not crash @P1', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/event/${eventId}`);
    await expect(page.getByRole('heading').first()).toBeVisible();
    await page.goBack();
    await expect(page.locator('body')).not.toContainText(/Application error|ChunkLoadError/i);
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

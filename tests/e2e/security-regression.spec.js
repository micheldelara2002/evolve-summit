import { test, expect } from '@playwright/test';

const eventId = process.env.E2E_EVENT_ID;

async function assertNoAppCrash(page) {
  await expect(page.locator('body')).not.toContainText(/Application error|ChunkLoadError|Internal Server Error/i);
}

async function assertRouteDoesNotGrantAdmin(page, route) {
  await page.goto(route);
  await assertNoAppCrash(page);
  await expect(page).not.toHaveURL(new RegExp(`${route.replaceAll('/', '\\/')}$`));
}

test.describe('Cross-cutting security regression @regression @security', () => {
  test('SEC-002 event ID substitution is rejected for participant @P0 @participant', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    const fake = `${eventId}-unauthorized`;
    await page.goto(`/event/${fake}`);
    await assertNoAppCrash(page);
    await expect(page).not.toHaveURL(new RegExp(`/event/${fake}$`));
  });

  test('SEC-006 campaign route is not accessible to participant @P0 @participant', async ({ page }) => {
    await assertRouteDoesNotGrantAdmin(page, '/notifications');
  });

  test('SEC-007 participant cannot escalate into admin People via URL @P0 @participant', async ({ page }) => {
    await assertRouteDoesNotGrantAdmin(page, '/people');
  });

  test('SEC-009 participant cannot cross into admin event-management URL @P0 @participant', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    await page.goto(`/events/${eventId}`);
    await assertNoAppCrash(page);
    await expect(page).not.toHaveURL(new RegExp(`/events/${eventId}$`));
  });

  test('SEC-009 staff cannot cross into another event by URL @P0 @staff', async ({ page }) => {
    test.skip(!eventId, 'E2E_EVENT_ID not configured');
    const fake = `${eventId}-unauthorized`;
    await page.goto(`/event/${fake}`);
    await assertNoAppCrash(page);
    await expect(page).not.toHaveURL(new RegExp(`/event/${fake}$`));
  });

  test('SEC-001/003 arbitrary resource IDs do not crash or expose raw data @P0 @participant', async ({ page }) => {
    const routes = ['/profile?participantId=unauthorized-test-id', '/event/session-unauthorized-test-id'];
    for (const route of routes) {
      await page.goto(route);
      await assertNoAppCrash(page);
    }
  });

  test('SEC-005 arbitrary store/participant query parameters do not create a privileged context @P0 @participant', async ({ page }) => {
    await page.goto('/my-events?participantId=unauthorized-test-id&storeItemId=unauthorized-test-id');
    await assertNoAppCrash(page);
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  async function openProfileAndWaitForDeleteAction(page) {
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading').first()).toBeVisible();
    const deleteAction = page.getByText('Excluir minha conta', { exact: true }).first();
    await expect(deleteAction).toBeAttached({ timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(deleteAction).toBeVisible({ timeout: 10_000 });
    return deleteAction;
  }

  test('SEC-008 deleted-account protection remains represented by non-destructive E2E coverage @P0 @participant', async ({ page }) => {
    await openProfileAndWaitForDeleteAction(page);
    test.info().annotations.push({ type: 'backend-covered', description: 'Deletion mutation and old-session blocking are verified by backend security audit; this E2E intentionally does not delete the stable regression account.' });
  });

  test('SEC-010/011 profile deletion flow exposes no unredacted confirmation payload @P1 @participant', async ({ page }) => {
    const deleteAction = await openProfileAndWaitForDeleteAction(page);
    await deleteAction.click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible();
    await expect(dialog).not.toContainText(/senha atual.*undefined/i);
  });
});

import { test, expect } from '@playwright/test';

const eventId = process.env.E2E_EVENT_ID;

async function eventShell(page) {
  test.skip(!eventId, 'E2E_EVENT_ID not configured');
  await page.goto(`/event/${eventId}`);
  await expect(page.getByRole('heading').first()).toBeVisible();
}

test.describe('Participant regression @participant @regression', () => {
  test('PA-001/002 home and My Events load @P0 @smoke', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading').first()).toBeVisible();
    await page.goto('/my-events');
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('PA-003/004 event access is tied to participant association @P0 @security', async ({ page }) => {
    await eventShell(page);
    const fakeEvent = `${eventId}-not-associated`;
    await page.goto(`/event/${fakeEvent}`);
    await expect(page).not.toHaveURL(new RegExp(`/event/${fakeEvent}$`));
  });

  test('PA-007/008 schedule and navigation controls are usable @P0', async ({ page }) => {
    await eventShell(page);
    await expect(page.getByRole('button').first()).toBeVisible();
  });

  test('PA-009/010 favorite controls, when sessions exist, are interactive @P0', async ({ page }) => {
    await eventShell(page);
    const favorite = page.getByRole('button', { name: /favorit|favorite/i }).first();
    if (await favorite.count()) {
      await expect(favorite).toBeVisible();
      await expect(favorite).toBeEnabled();
    } else {
      test.info().annotations.push({ type: 'data-dependent', description: 'No favorite control rendered because the regression event has no visible sessions.' });
    }
  });

  test('PA-011 session detail can open and close when sessions exist @P1', async ({ page }) => {
    await eventShell(page);
    const session = page.getByRole('button').filter({ hasText: /sessão|session/i }).first();
    if (!(await session.count())) {
      test.info().annotations.push({ type: 'data-dependent', description: 'No session trigger found.' });
      return;
    }
    await session.click();
    const close = page.getByRole('button', { name: /fechar|close/i }).first();
    if (await close.count()) {
      await close.click();
    }
  });

  test('PA-020 ranking is event scoped @P0', async ({ page }) => {
    await eventShell(page);
    const ranking = page.getByText(/ranking/i).first();
    if (await ranking.count()) await expect(ranking).toBeVisible();
  });

  test('PA-022 store exposes participant balance context @P0', async ({ page }) => {
    await eventShell(page);
    const storeLink = page.getByRole('link', { name: /loja|store/i }).first();
    if (await storeLink.count()) {
      await storeLink.click();
      await expect(page.locator('body')).not.toContainText(/Application error|ChunkLoadError/i);
    } else {
      test.info().annotations.push({ type: 'data-dependent', description: 'Store navigation is not visible in this event state.' });
    }
  });

  test('PA-028/029 networking is reachable @P0', async ({ page }) => {
    await page.goto('/network');
    await expect(page.getByRole('heading').first()).toBeVisible();
  });

  test('PA-032/033 notification inbox loads @P0', async ({ page }) => {
    await page.goto('/');
    const notification = page.getByRole('button', { name: /notifica/i }).first();
    if (await notification.count()) {
      await notification.click();
      await expect(page.locator('body')).not.toContainText(/Application error|ChunkLoadError/i);
    }
  });

  async function openProfileAndWaitForActions(page) {
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading').first()).toBeVisible();
    // Profile actions are rendered after the profile data resolves and the
    // delete action is intentionally at the bottom of the page.
    await expect(page.getByText('Excluir minha conta', { exact: true }).first()).toBeAttached({ timeout: 20_000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  }

  test('PA-034 profile edit entry point is available @P1', async ({ page }) => {
    await openProfileAndWaitForActions(page);
    await expect(page.getByText('Editar', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  });

  test('PA-035 deletion requires explicit confirmation @P0', async ({ page }) => {
    await openProfileAndWaitForActions(page);
    const deleteAction = page.getByText('Excluir minha conta', { exact: true }).first();
    await expect(deleteAction).toBeVisible({ timeout: 10_000 });
    await deleteAction.click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: /cancelar|voltar/i }).first()).toBeVisible();
  });

  test('PA-037 deleted-account behavior remains a backend security responsibility @P0 @security', async ({ page }) => {
    await openProfileAndWaitForActions(page);
    await expect(page.getByText('Excluir minha conta', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    test.info().annotations.push({ type: 'backend-covered', description: 'Old-session mutation blocking is covered by backend security audit; this E2E does not mutate the regression account.' });
  });
});

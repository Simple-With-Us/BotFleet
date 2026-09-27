import { test, expect } from '@playwright/test';

// Automated visual verification for web surfaces (owner directive
// 2026-09-27). The native Mac desktop app is NOT covered here — Playwright
// cannot drive it; that surface stays on code review + CI.
//
// Every screen below renders deterministically against `vite preview` with
// no bot server and no network: animated bits are frozen with
// `animations: 'disabled'` and any section that could reach for live state
// is excluded by construction (see the notes per test).
// `caret: 'hide'` because step 0 autofocuses the name field: the blinking
// text caret would otherwise make two consecutive screenshots differ.
const stableShot = { animations: 'disabled', caret: 'hide' } as const;

test('visual: onboarding welcome (first-run email gate)', async ({ page }) => {
  // Fresh context => the `omb-email-gate` key is absent => step 0 of the
  // gate: static welcome copy plus name/email fields. Later steps run live
  // engine checks, so they are intentionally not screenshotted.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to BotFleet' })).toBeVisible();
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
  // The BotMascot is a requestAnimationFrame-driven avatar (blinking,
  // drift, expression pool) that CSS animation freezing cannot stop, so it
  // is masked: the welcome copy and form — the actual UI surface — are
  // still asserted pixel-for-pixel.
  await expect(page).toHaveScreenshot('onboarding-welcome.png', {
    ...stableShot,
    mask: [page.locator('.fixed.inset-0.z-50 svg').first()],
  });
});

test('visual: app shell with no bot server', async ({ page }) => {
  // Dismiss the first-run gate via localStorage so the shell is uncovered.
  // With no server, the store stays disconnected and the shell shows the
  // static sidebar plus the "start the bot server" hint — nothing polls or
  // streams in this state.
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
  await page.goto('/');
  await expect(page.getByTitle('App Settings')).toBeVisible();
  await expect(page.getByText('Connecting to the bot server…')).toBeVisible();
  // Without a server, hydration fails and retries on a 1s/3s/10s backoff
  // before settling on "Reopen BotFleet to try again." — wait for that
  // final, stable state so the retry banner cannot flake the screenshot.
  await expect(page.getByText('Reopen BotFleet to try again.')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveScreenshot('app-shell-no-server.png', stableShot);
});

test('visual: settings modal (General section)', async ({ page }) => {
  // General is the only section with no server or bridge dependence: the
  // Updates card renders null without a Mac harness or updater bridge, and
  // every remaining row is a static control or toggle.
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
  await page.goto('/');
  await page.getByTitle('App Settings').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Profile', { exact: true })).toBeVisible();
  await expect(dialog).toHaveScreenshot('settings-general.png', stableShot);
});

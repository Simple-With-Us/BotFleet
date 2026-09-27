import { test, expect, type Page } from '@playwright/test';

// Automated visual verification for BotFleet's web surfaces (owner directive,
// 2026-09-27). Each test asserts a full-page screenshot against a committed
// baseline in tests/e2e/visual.spec.ts-snapshots/. Regenerate with
// `pnpm exec playwright test visual --update-snapshots`.
//
// The fixture serves the static production build (`vite preview`) with NO
// backend server, so every screen targets a deterministic first-run / empty
// state: no live agent activity, no network-dependent content. Dynamic bits
// are pinned down per-test:
// - the clock is frozen (the routines calendar header renders the current
//   month; hydration retry text branches on Date.now()),
// - CSS animations/transitions and the text caret are disabled,
// - with no server the app always shows the "saved data could not refresh"
//   banner ~1s after load, so tests wait for it before screenshotting,
// - the onboarding mascot's idle blink is masked (no CSS freeze stops it).

test.use({ viewport: { width: 1440, height: 900 } });

/** Sun Sep 27 2026, 12:00 CT — the day this suite was written. */
const FROZEN_NOW_MS = new Date('2026-09-27T17:00:00Z').getTime();

/** Pin Date/Date.now() to FROZEN_NOW_MS before any page script runs. */
async function freezeClock(page: Page): Promise<void> {
  await page.addInitScript((frozenNow: number) => {
    const RealDate = window.Date;
    class FrozenDate extends RealDate {
      constructor(...args: unknown[]) {
        const ctorArgs = (args.length === 0 ? [frozenNow] : args) as ConstructorParameters<
          typeof RealDate
        >;
        super(...ctorArgs);
      }
      static now(): number {
        return frozenNow;
      }
    }
    window.Date = FrozenDate as unknown as typeof RealDate;
  }, FROZEN_NOW_MS);
}

/** Skip the first-run email gate: fresh contexts see onboarding otherwise. */
async function skipEmailGate(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
}

/** Freeze anything that moves: spinner animations, transitions, text caret. */
async function stabilize(page: Page): Promise<void> {
  // Blur the focused element first: the onboarding name input autofocuses,
  // and its blinking caret defeats pixel comparison.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0s !important;
        caret-color: transparent !important;
      }
    `,
  });
}

/** The shell's deterministic post-load state: connecting notice on, and the
 * hydration-failure banner up (it always appears ~1s after load with no
 * backend). Waiting for both removes screenshot-timing flakes. */
async function waitForSettledShell(page: Page): Promise<void> {
  await expect(page.getByText('Connecting to the bot server…')).toBeVisible();
  await expect(page.getByText('Some saved data could not refresh.')).toBeVisible();
}

test.describe('visual: web surfaces', () => {
  test('onboarding welcome screen', async ({ page }) => {
    // Fresh context: no email-gate flag, so first-run onboarding step 0
    // (the static welcome + name/email form) renders over the shell.
    await freezeClock(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome to BotFleet' })).toBeVisible();
    await stabilize(page);
    // The bot mascot idles with a periodic blink that no CSS freeze stops;
    // mask it so the layout, copy, and form still verify deterministically.
    await expect(page, 'onboarding welcome screenshot').toHaveScreenshot('onboarding-welcome.png', {
      mask: [page.locator('div.z-50 svg')],
    });
  });

  test('app shell: sidebar + server-connecting state', async ({ page }) => {
    await freezeClock(page);
    await skipEmailGate(page);
    await page.goto('/');
    await waitForSettledShell(page);
    await stabilize(page);
    await expect(page, 'app shell screenshot').toHaveScreenshot('app-shell-empty.png');
  });

  test('app settings modal: general section', async ({ page }) => {
    await freezeClock(page);
    await skipEmailGate(page);
    await page.goto('/');
    await waitForSettledShell(page);
    await page.getByTitle('App Settings').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Settings', { exact: true })).toBeVisible();
    await stabilize(page);
    await expect(page, 'app settings screenshot').toHaveScreenshot('app-settings-general.png');
  });

  test('tasks & routines: empty state', async ({ page }) => {
    await freezeClock(page);
    await skipEmailGate(page);
    await page.goto('/');
    await waitForSettledShell(page);
    await page.getByRole('button', { name: /Tasks & Routines/ }).click();
    // No bots and no routines in this fixture: the empty state is static.
    await expect(page.getByText('Create Your First Routine')).toBeVisible();
    await stabilize(page);
    await expect(page, 'routines empty-state screenshot').toHaveScreenshot('routines-empty.png');
  });
});

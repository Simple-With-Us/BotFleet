import { test, expect, type Page } from '@playwright/test';

// The line a chat or a room shows while an update holds new work.  A message
// sent in that window is accepted and kept, and runs after the restart; with
// nothing on screen a bot looks stuck and a room goes quiet.  The fixture
// mounts the real, connected <UpdateDrainNotice /> via /?fixture=update-drain
// (see src/main.tsx); the only thing faked is the harness's own
// `GET /api/update/status` answer, which carries the hold exactly as
// server/update-control.ts reports it.
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts.
// The baseline is the Linux render CI produces (…-chromium-linux.png), like
// every other visual spec here.
const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

// The countdown reads Date.now(), so pin the clock: the hold below ends six
// minutes after this instant and the line says so, however long the run takes.
const FIXED_NOW = new Date('2026-06-15T13:00:00Z');
const MINUTE = 60_000;
const LINUX_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function pinFonts(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        font-family: "DejaVu Sans", sans-serif !important;
      }
      code, kbd, pre, samp, tt {
        font-family: "DejaVu Sans Mono", monospace !important;
      }
    `,
  });
}

/** `GET /api/update/status` the way the harness answers it, without a hold. */
const idleStatus = {
  installed: { version: '1.0.31', sourceCommit: 'a'.repeat(40) },
  available: null,
  checkedAt: null,
  checkError: null,
  running: null,
  lastRun: null,
  capabilities: { canCheck: true, canRun: true, reasons: [], codes: [], busy: false },
};

/** The same answer while an update holds new work: three bots mid-turn, three messages saved. */
const holdingStatus = {
  ...idleStatus,
  capabilities: { ...idleStatus.capabilities, busy: true },
  drain: {
    startedAt: FIXED_NOW.getTime(),
    windowEndsAt: FIXED_NOW.getTime() + 6 * MINUTE,
    deadline: FIXED_NOW.getTime() + 8 * MINUTE,
    bots: 3,
    rooms: 0,
    held: { sends: 2, rooms: 1, routineRuns: 0 },
  },
};

test.use({
  viewport: { width: 900, height: 400 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test('visual: a chat says messages are saved while an update holds new work', async ({ page }) => {
  await page.clock.install({ time: FIXED_NOW });
  await page.route('**/api/update/status', (route) => route.fulfill({ json: holdingStatus }));
  await page.goto('/?fixture=update-drain');
  await pinFonts(page);

  const notice = page.getByTestId('update-drain-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice).toContainText('BotFleet is updating.');
  await expect(notice).toContainText('Messages you send now are saved and will run after the restart.');
  await expect(notice).toContainText('The restart begins within about 6 minutes.');

  await expect(page.getByTestId('update-drain-frame')).toHaveScreenshot('update-drain-notice.png', stableShot);
});

test('a chat says nothing when no update is holding anything', async ({ page }) => {
  await page.clock.install({ time: FIXED_NOW });
  const asked = page.waitForRequest('**/api/update/status');
  await page.route('**/api/update/status', (route) => route.fulfill({ json: idleStatus }));
  await page.goto('/?fixture=update-drain');
  await asked;

  await expect(page.getByTestId('update-drain-frame')).toBeVisible();
  await expect(page.getByTestId('update-drain-notice')).toHaveCount(0);
});

import { test, expect, type Page, type Locator } from '@playwright/test';

// ComputerPanel warning sentences. The fixture mounts the real panel via
// /?fixture=computer-panel (see src/main.tsx). There is no visual-tests/
// directory; this follows tests/e2e/visual.spec.ts.
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.  Those match visual.spec.ts
// (0.02 explicit, 0.2 by Playwright's default).  Only animation and caret
// handling stay on the call.  No mask: these cards have no animated mascot
// or live frame.
const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

// The Runs On row labels "This Mac" when the user agent contains "Mac".
// Pin a Linux Chrome UA so that label cannot drift between hosts. Desktop
// capabilities stay the browser fallback (no window.ogb), which is the same
// on every Playwright chromium lane.
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

/** The nearest rounded container around the sentence, which is the warning card. */
function warningCard(page: Page, text: RegExp): Locator {
  return page.getByText(text).locator('xpath=ancestor::div[contains(@class,"rounded-")][1]');
}

test.use({
  viewport: { width: 1280, height: 1000 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test.beforeEach(async ({ page }) => {
  await page.route('**/api/bots/visual-bot/computer**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/computer/control')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ held: false, helpReason: null }),
      });
    }
    if (route.request().method() === 'GET' && url.pathname.endsWith('/computer')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: false,
          imageMatches: true,
          managed: false,
          container: 'missing',
          ready: false,
          problem: null,
        }),
      });
    }
    return route.fallback();
  });
});

test('visual: ComputerPanel VPS unconfigured warning', async ({ page }) => {
  await page.goto('/?fixture=computer-panel&warning=unconfigured');
  await pinFonts(page);

  const board = page.getByTestId('computer-panel-board');
  await expect(board).toBeVisible();
  const card = warningCard(page, /Configure the VPS SSH alias in App Settings → Connections\.\s+Auto only reuses an existing ready container\./);
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Open VPS settings' })).toBeVisible();
  await expect(board.getByText('This Computer', { exact: true })).toBeVisible();

  await expect(card).toHaveScreenshot('computer-panel-vps-unconfigured.png', stableShot);
});

test('visual: ComputerPanel VPS auto-start and off-computer warnings', async ({ page }) => {
  await page.goto('/?fixture=computer-panel');
  await pinFonts(page);

  const board = page.getByTestId('computer-panel-board');
  await expect(board).toBeVisible();
  const autoStart = warningCard(page, /Off by default\.\s+When enabled, Auto may create or wake this bot's managed container\./);
  await expect(autoStart).toBeVisible();
  await expect(autoStart.getByRole('switch', { name: 'Start VPS automatically' })).toBeVisible();

  const schedule = warningCard(page, /Scheduled tasks on this computer will not have desktop access while this is Off\.\s+Choose ASCII\.dev Box in the schedule editor to run the whole job there\./);
  await expect(schedule).toBeVisible();
  await expect(board.getByText('This Computer', { exact: true })).toBeVisible();

  await expect(autoStart).toHaveScreenshot('computer-panel-vps-auto-start.png', stableShot);
  await expect(schedule).toHaveScreenshot('computer-panel-schedule-off.png', stableShot);
});

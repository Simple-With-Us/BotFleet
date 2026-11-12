import { test, expect, type Locator, type Page } from '@playwright/test';

// UsageMonitorQuotaGrid in Settings → Usage: plan metadata, absolute
// limits, and per-window reset countdowns.  The fixture mounts fixed windows
// via /?fixture=usage-monitor-quota-grid&state=… (see
// src/components/UsageMonitorQuotaGridVisualFixture.tsx), so nothing here
// mocks a route.  Regenerate baselines with
// `pnpm run e2e:update tests/e2e/usage-monitor-quota-grid.visual.spec.ts`.
//
// Reset countdowns are frozen with page.clock and masked on the snapshot so
// a later drift in wording or sub-minute rounding cannot fail the compare.

const FIXED_NOW = '2026-10-10T15:00:00Z';
const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

const LINUX_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const GRID_STATES = ['populated', 'empty', 'near-limit', 'exhausted'] as const;
type GridState = (typeof GRID_STATES)[number];

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

function resetCountdownMask(panel: Locator): Locator[] {
  return [panel.getByText(/^Resets in /)];
}

async function openGrid(page: Page, state: GridState, theme: 'light' | 'dark'): Promise<Locator> {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
  );
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  const themeQuery = theme === 'dark' ? '&theme=dark' : '';
  await page.goto(`/?fixture=usage-monitor-quota-grid&state=${state}${themeQuery}`);
  await pinFonts(page);
  const panel = page.getByTestId('usage-grid-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test.use({
  viewport: { width: 520, height: 720 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

for (const theme of ['light', 'dark'] as const) {
  for (const state of GRID_STATES) {
    test(`visual: usage quota grid — ${state} (${theme})`, async ({ page }) => {
      const panel = await openGrid(page, state, theme);

      if (state === 'populated') {
        await expect(panel.getByLabel('Usage Monitor quota windows')).toBeVisible();
        await expect(panel.getByText('Detected Plan: ChatGPT Ultra')).toBeVisible();
        await expect(panel.getByText('$248 of $400 on Ultra')).toBeVisible();
        await expect(panel.getByText('62% remaining')).toBeVisible();
        await expect(panel.getByText('Resets in 4h').first()).toBeVisible();
      } else if (state === 'empty') {
        await expect(panel.getByTestId('usage-grid-empty-placeholder')).toBeVisible();
        await expect(panel.getByLabel('Usage Monitor quota windows')).toHaveCount(0);
      } else if (state === 'near-limit') {
        await expect(panel.getByText('15% remaining')).toBeVisible();
        await expect(panel.getByText('18% remaining')).toBeVisible();
        await expect(panel.getByText('Detected Plan: Max')).toBeVisible();
      } else {
        await expect(panel.getByText('0% remaining').first()).toBeVisible();
        await expect(panel.getByText('$0 of $400 on Ultra')).toBeVisible();
      }

      await expect(panel).toHaveScreenshot(`usage-grid-${state}-${theme}.png`, {
        ...stableShot,
        maxDiffPixelRatio: 0.02,
        threshold: 0.2,
        mask: resetCountdownMask(panel),
      });
    });
  }
}

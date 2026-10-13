import { test, expect, type Page, type Locator } from '@playwright/test';

// FleetMatrixView visual coverage for both view modes (Matrix Grid +
// Kanban Board).  The fixture mounts the real FleetMatrixView via
// /?fixture=fleet-matrix-view&view=matrix|kanban (see src/main.tsx).  The
// harness persists the view choice to localStorage so the
// FleetMatrixView's persisted viewMode initializer picks it up on the
// first render.  There is no visual-tests/ directory; this follows
// tests/e2e/visual.spec.ts.
const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

const LINUX_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Fixture PINNED_TS is 1730000000000.  Pin Date.now so wait labels and
// relative sorts stay identical across hosts and runs.
const PINNED_NOW = 1_730_000_000_000;

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

async function pinNow(page: Page): Promise<void> {
  await page.addInitScript((now) => {
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) super(now);
        else super(...args);
      }
      static now() {
        return now;
      }
    }
    // SAFETY: Playwright test-only hook; the page is discarded after each run.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Date = FrozenDate;
  }, PINNED_NOW);
}

function dynamicMasks(view: Locator): Locator[] {
  // Wait labels ("Xm waiting"), completed-column clock stamps, and the
  // telemetry strip ("N Cards") — mask so a host/locale clock format cannot
  // flake the shot even with Date.now pinned.
  return [
    view.getByText(/\d+[smh]/),
    view.getByText(/\d{1,2}:\d{2}/),
    view.getByText(/\d+ Cards/),
  ];
}

test.use({
  viewport: { width: 1500, height: 1024 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test('visual: FleetMatrixView matrix grid mode', async ({ page }) => {
  await pinNow(page);
  await page.goto('/?fixture=fleet-matrix-view&view=matrix');
  await pinFonts(page);

  const view = page.getByTestId('fleet-matrix-view');
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute('data-fixture-view', 'matrix');

  // Header copy is the matrix-grid version of the title.
  await expect(view.getByRole('heading', { name: /Fleet Matrix/ })).toBeVisible();

  // View-mode switcher is rendered with both buttons available.
  await expect(view.getByRole('button', { name: 'Matrix Grid' })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Kanban Board' })).toBeVisible();

  // At least one row per app, plus the AppDeck chrome.
  await expect(view.getByText('Ops Console')).toBeVisible();
  await expect(view.getByText('Tools Suite')).toBeVisible();

  await expect(view).toHaveScreenshot(
    'fleet-matrix-view-matrix.png',
    { ...stableShot, mask: dynamicMasks(view) },
  );
});

test('visual: FleetMatrixView kanban board mode', async ({ page }) => {
  await pinNow(page);
  await page.goto('/?fixture=fleet-matrix-view&view=kanban');
  await pinFonts(page);

  const view = page.getByTestId('fleet-matrix-view');
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute('data-fixture-view', 'kanban');

  // Header copy switches to the kanban title.
  await expect(view.getByRole('heading', { name: 'Kanban Command Center' })).toBeVisible();

  // 4-column board headings are all present.
  await expect(view.getByRole('heading', { name: 'Attention Queue' })).toBeVisible();
  await expect(view.getByRole('heading', { name: 'In Progress' })).toBeVisible();
  await expect(view.getByRole('heading', { name: 'Ready & Standby' })).toBeVisible();
  await expect(view.getByRole('heading', { name: 'Completed' })).toBeVisible();

  await expect(view).toHaveScreenshot(
    'fleet-matrix-view-kanban.png',
    { ...stableShot, mask: dynamicMasks(view) },
  );
});

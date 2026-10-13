import { test, expect, type Page, type Locator } from '@playwright/test';

// KanbanCommandCenter visual coverage.
//
// There is no top-level `visual-tests/` directory in this repo.  The
// existing convention is `tests/e2e/*.visual.spec.ts` (see
// computer-panel.visual.spec.ts, engine-setup.visual.spec.ts,
// tv-face-avatar.visual.spec.ts, visual.spec.ts) with fixtures loaded via
// `/?fixture=...` in src/main.tsx.  The update path is
// `pnpm exec playwright test tests/e2e/kanban-command-center.visual.spec.ts
//  --update-snapshots` — the same `pnpm test:e2e` lane, not a separate
// `cd visual-tests && npm ci` step.
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.  Call sites only set animation
// and caret handling, plus Playwright masks for dynamic regions.
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

function dynamicMasks(board: Locator): Locator[] {
  // Wait labels ("Xm waiting"), completed-column clock stamps, and the
  // telemetry strip ("N Cards") — mask so a host/locale clock format cannot
  // flake the shot even with Date.now pinned.
  return [
    board.getByText(/\d+[smh]/),
    board.getByText(/\d{1,2}:\d{2}/),
    board.getByText(/\d+ Cards/),
  ];
}

test.use({
  viewport: { width: 1500, height: 1024 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test('visual: KanbanCommandCenter populated board', async ({ page }) => {
  await pinNow(page);
  await page.goto('/?fixture=kanban-command-center&state=populated');
  await pinFonts(page);

  const board = page.getByTestId('kanban-board');
  await expect(board).toBeVisible();
  await expect(board).toHaveAttribute('data-fixture-state', 'populated');

  await expect(board.getByRole('heading', { name: 'Attention Queue' })).toBeVisible();
  await expect(board.getByRole('heading', { name: 'In Progress' })).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Ready & Standby' })).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Completed' })).toBeVisible();

  await expect(board).toHaveScreenshot(
    'kanban-command-center-populated.png',
    { ...stableShot, mask: dynamicMasks(board) },
  );
});

test('visual: KanbanCommandCenter empty board', async ({ page }) => {
  await pinNow(page);
  await page.goto('/?fixture=kanban-command-center&state=empty');
  await pinFonts(page);

  const board = page.getByTestId('kanban-board');
  await expect(board).toBeVisible();
  await expect(board).toHaveAttribute('data-fixture-state', 'empty');

  await expect(board.getByText(/All clear\.\s+No blocked bots or pending approvals\./)).toBeVisible();
  await expect(board.getByText('No bots actively running turns right now.')).toBeVisible();
  await expect(board.getByText('All bots busy or assigned to other tasks.')).toBeVisible();
  await expect(
    board.getByText('Finished routine runs will appear here with output receipts.'),
  ).toBeVisible();

  await expect(board).toHaveScreenshot(
    'kanban-command-center-empty.png',
    stableShot,
  );
});

test('visual: KanbanCommandCenter filtered board', async ({ page }) => {
  await pinNow(page);
  await page.goto('/?fixture=kanban-command-center&state=populated');
  await pinFonts(page);

  const board = page.getByTestId('kanban-board');
  await expect(board).toBeVisible();

  // Filter to Approver so only matching attention/waiting cards remain.
  await board.getByPlaceholder('Filter tasks, bots, or apps...').fill('Approver');
  await expect(board.getByText('Approver is waiting for decision')).toBeVisible();
  await expect(board.getByText('Crashy encountered an unhandled crash')).toHaveCount(0);

  await expect(board).toHaveScreenshot(
    'kanban-command-center-filtered.png',
    { ...stableShot, mask: dynamicMasks(board) },
  );
});

test('visual: KanbanCommandCenter narrow viewport board', async ({ page }) => {
  await pinNow(page);
  await page.setViewportSize({ width: 720, height: 1100 });
  await page.goto('/?fixture=kanban-command-center&state=populated');
  await pinFonts(page);

  const board = page.getByTestId('kanban-board');
  await expect(board).toBeVisible();
  await expect(board.getByRole('heading', { name: 'Attention Queue' })).toBeVisible();

  await expect(board).toHaveScreenshot(
    'kanban-command-center-narrow.png',
    { ...stableShot, mask: dynamicMasks(board) },
  );
});

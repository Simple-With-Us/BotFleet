import { test, expect, type Page } from '@playwright/test';

// Bot context menu → Merge All Threads visual coverage.
//
// The repo's convention is `tests/e2e/*.visual.spec.ts` with fixtures loaded
// via `/?fixture=...` (see conversation-mode-row.visual.spec.ts).  Baseline
// regeneration is `pnpm exec playwright test
// tests/e2e/merge-all-threads.visual.spec.ts --update-snapshots`.
//
// This dialog is the one place a person chooses which conversation survives
// when a bot's threads are gathered, so two things are pinned: the copy that
// says what will happen, and the fact that the OLDEST conversation is offered
// as the destination by default (a merge appends the other transcripts to the
// destination, so the oldest one keeps the transcript reading in order).
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.
const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

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

test.use({
  viewport: { width: 720, height: 720 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test('visual: the merge picker offers every conversation and names what will be folded in', async ({ page }) => {
  await page.goto('/?fixture=merge-all-threads');
  await pinFonts(page);

  const fixture = page.getByTestId('merge-all-threads-fixture');
  await expect(fixture).toBeVisible();

  const dialog = page.getByTestId('merge-all-threads-dialog');
  await expect(dialog.getByText('Merge All Threads')).toBeVisible();

  // Every conversation is listed with how much it holds.
  await expect(dialog.getByRole('radio', { name: /Fleet coordination/ })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Release pipeline/ })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Usage Monitor heartbeat/ })).toBeVisible();
  await expect(dialog.getByText('4,211')).toBeVisible();
  await expect(dialog.getByText('312')).toBeVisible();

  // The oldest conversation is the destination by default, so the merged
  // text lands after it and the transcript still reads in order.
  await expect(dialog.getByRole('radio', { name: /Fleet coordination/ })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: /Release pipeline/ })).not.toBeChecked();

  // The summary says how many will move and where they will go.
  const summary = dialog.getByTestId('merge-all-threads-summary');
  await expect(summary).toContainText('2 conversations will be folded into');
  await expect(dialog.getByTestId('merge-all-threads-destination')).toHaveText('Fleet coordination');
  await expect(summary).toContainText('cannot be undone');

  await expect(dialog).toHaveScreenshot(
    'merge-all-threads-picker.png',
    { ...stableShot, maxDiffPixelRatio: 0.02, threshold: 0.2 },
  );
});

test('visual: choosing another destination moves the summary with it', async ({ page }) => {
  await page.goto('/?fixture=merge-all-threads');
  await pinFonts(page);

  const dialog = page.getByTestId('merge-all-threads-dialog');
  await dialog.getByRole('radio', { name: /Usage Monitor heartbeat/ }).click();

  await expect(dialog.getByRole('radio', { name: /Usage Monitor heartbeat/ })).toBeChecked();
  await expect(dialog.getByTestId('merge-all-threads-summary')).toContainText(
    '2 conversations will be folded into',
  );
  await expect(dialog.getByTestId('merge-all-threads-destination')).toHaveText('Usage Monitor heartbeat');

  await expect(dialog).toHaveScreenshot(
    'merge-all-threads-picker-chosen.png',
    { ...stableShot, maxDiffPixelRatio: 0.02, threshold: 0.2 },
  );
});

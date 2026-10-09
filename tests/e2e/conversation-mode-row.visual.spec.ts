import { test, expect, type Page } from '@playwright/test';

// Settings → Workspace Arrangement visual coverage.
//
// The repo has no top-level `visual-tests/` directory; the convention is
// `tests/e2e/*.visual.spec.ts` with fixtures loaded via `/?fixture=...`
// (see bypass-warning.visual.spec.ts, usage-notices.visual.spec.ts).
// Baseline regeneration is `pnpm exec playwright test
// tests/e2e/conversation-mode-row.visual.spec.ts --update-snapshots`.
//
// The Projects row's subtitle visibly interpolates the person's own
// lowercased singular room word, so we pin two room labels (channels, the
// default, and rooms, a non-default preset) to catch any drift between
// labels.  The Pending-Simple merge panel is reached by clicking Simple
// while Projects is current; the local pendingSimple useState renders the
// card without going through the API.
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

test('visual: Projects row with channel labels interpolates the singular room word', async ({ page }) => {
  await page.goto('/?fixture=conversation-mode-row&room=channel');
  await pinFonts(page);

  const row = page.getByTestId('conversation-mode-row-fixture');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-fixture-room', 'channel');

  // Header card copy uses Channels / each channel.
  await expect(row.getByText('Workspace Arrangement')).toBeVisible();
  await expect(
    row.getByText(/Choose how your bots and channels are structured/),
  ).toBeVisible();
  // Projects row title is the plural label.
  await expect(row.getByRole('button', { name: 'Channels' })).toBeVisible();
  // Projects subtitle uses the interpolated singular — "channel", lowercase.
  await expect(
    row.getByText(
      "Any number of threads under each bot and channel, nested in the sidebar.  A thread can be tied to one channel.",
    ),
  ).toBeVisible();
  // Simple subtitle is unchanged.
  await expect(
    row.getByText(
      'Named bots with one conversation each, plus group threads that invited bots and you can all write in.',
    ),
  ).toBeVisible();

  await expect(row).toHaveScreenshot(
    'conversation-mode-row-channels.png',
    {
      ...stableShot,
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
      mask: [page.locator('[data-fixture-clock]'), page.locator('[data-fixture-timestamp]')],
    },
  );
});

test('visual: Projects row with room labels interpolates the singular room word', async ({ page }) => {
  await page.goto('/?fixture=conversation-mode-row&room=room');
  await pinFonts(page);

  const row = page.getByTestId('conversation-mode-row-fixture');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-fixture-room', 'room');

  // Header card copy uses Rooms / each room.
  await expect(
    row.getByText(/Choose how your bots and rooms are structured/),
  ).toBeVisible();
  // Projects row title is the plural label.
  await expect(row.getByRole('button', { name: 'Rooms' })).toBeVisible();
  // Projects subtitle uses the interpolated singular — "room".
  await expect(
    row.getByText(
      "Any number of threads under each bot and room, nested in the sidebar.  A thread can be tied to one room.",
    ),
  ).toBeVisible();

  await expect(row).toHaveScreenshot(
    'conversation-mode-row-rooms.png',
    {
      ...stableShot,
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
      mask: [page.locator('[data-fixture-clock]'), page.locator('[data-fixture-timestamp]')],
    },
  );
});

test('visual: switching from Projects to Simple opens the merge panel with the new copy', async ({ page }) => {
  await page.goto('/?fixture=conversation-mode-row&room=channel');
  await pinFonts(page);

  const row = page.getByTestId('conversation-mode-row-fixture');
  await expect(row).toBeVisible();
  // Click the Simple option while Projects is current; the row's local
  // pendingSimple state opens the merge card without an API call.
  await row.getByRole('button', { name: 'Simple' }).click();
  // New copy on the merge card and the renamed primary button.
  await expect(
    row.getByText(
      'Simple is one conversation per bot.  Merge extra threads into that conversation, or keep them saved and out of the sidebar.',
    ),
  ).toBeVisible();
  await expect(row.getByRole('button', { name: 'Keep Them Out of the Sidebar' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Merge All Threads' })).toBeVisible();

  await expect(row).toHaveScreenshot(
    'conversation-mode-row-merge.png',
    {
      ...stableShot,
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
      mask: [page.locator('[data-fixture-clock]'), page.locator('[data-fixture-timestamp]')],
    },
  );
});

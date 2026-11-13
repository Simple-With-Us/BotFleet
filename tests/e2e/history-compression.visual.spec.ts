import { test, expect, type Page } from '@playwright/test';

// History Compression controls in bot settings: the editable card on an
// engine that budgets its prompt, and the read-only card with the reason on
// one that keeps its own history.  The fixture mounts the real
// HistoryCompressionField via /?fixture=history-compression&state=editable|readonly
// (see src/main.tsx).  Regenerate baselines with
// `pnpm run e2e:update tests/e2e/history-compression.visual.spec.ts`, no `--`.
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
  viewport: { width: 640, height: 560 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

async function openState(page: Page, state: 'editable' | 'readonly') {
  await page.goto(`/?fixture=history-compression&state=${state}`);
  await pinFonts(page);
  const fixture = page.getByTestId('history-compression-fixture');
  await expect(fixture).toBeVisible();
  await expect(fixture).toHaveAttribute('data-fixture-state', state);
  return fixture;
}

test('visual: history compression editable', async ({ page }) => {
  const fixture = await openState(page, 'editable');
  await expect(fixture.getByText('History Compression')).toBeVisible();
  await expect(fixture.getByLabel('Maximum History Turns')).toHaveValue('10');
  await expect(fixture.getByLabel('Model-Written Summary')).toBeChecked();

  await expect(page.getByTestId('history-compression-card')).toHaveScreenshot(
    'history-compression-editable.png',
    {
      ...stableShot,
      // The Maximum History Turns value is user-controlled: mask it so a
      // changed value cannot flake the comparison.
      mask: [fixture.getByLabel('Maximum History Turns')],
      maxDiffPixelRatio: 0.01,
    },
  );
});

test('visual: history compression read-only on an engine with its own history', async ({ page }) => {
  const fixture = await openState(page, 'readonly');
  await expect(fixture.getByText('History Compression')).toBeVisible();
  await expect(fixture.getByLabel('Maximum History Turns')).toHaveValue('50');
  await expect(fixture.getByLabel('Maximum History Turns')).toBeDisabled();
  await expect(fixture.getByText(/keeps its own history/)).toBeVisible();

  await expect(page.getByTestId('history-compression-card')).toHaveScreenshot(
    'history-compression-readonly.png',
    {
      ...stableShot,
      mask: [fixture.getByLabel('Maximum History Turns')],
      maxDiffPixelRatio: 0.01,
    },
  );
});

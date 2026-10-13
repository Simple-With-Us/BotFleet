import { test, expect, type Page } from '@playwright/test';

const stableShot = {
  animations: 'disabled',
  caret: 'hide',
  maxDiffPixels: 0,
  maxDiffPixelRatio: 0,
  threshold: 0,
} as const;

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

test.use({ viewport: { width: 720, height: 620 }, locale: 'en-US' });

test('visual: OpenAI-compatible stays hidden until configured', async ({ page }) => {
  await page.goto('/?fixture=engine-callout');
  await pinFonts(page);

  const hidden = page.getByTestId('openai-hidden-state');
  await expect(hidden).toBeVisible();
  await expect(hidden.getByText('OpenAI-Compatible')).toHaveCount(0);
  await expect(hidden.getByText('Codex')).toBeVisible();
  await expect(hidden).toHaveScreenshot('engine-settings-openai-hidden.png', stableShot);
});

test('visual: configured OpenAI-compatible shows neutral endpoint facts', async ({ page }) => {
  await page.goto('/?fixture=engine-callout');
  await pinFonts(page);

  const configured = page.getByTestId('openai-configured-state');
  await expect(configured).toBeVisible();
  await expect(configured.getByText('OpenAI-Compatible')).toBeVisible();
  await expect(configured.getByText('vendor/model-a, vendor/model-b')).toBeVisible();
  await expect(configured.getByText('More Info')).toHaveCount(0);
  await expect(configured).toHaveScreenshot('engine-settings-openai-configured.png', stableShot);
});

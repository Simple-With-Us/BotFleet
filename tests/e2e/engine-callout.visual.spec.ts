import { test, expect, type Page } from '@playwright/test';

// The More Info block, in both shapes it can take.  The fixture mounts
// the real `EngineCalloutBody` via /?fixture=engine-callout (see src/main.tsx).
// There is no visual-tests/ directory; this follows tests/e2e/visual.spec.ts.
//
// Why this spec exists:  the block gained a provider-mark row, and the two
// shapes regress independently.  With marks, the label and headline must not
// pick up a 6px flex gap where the rendered space was, and wrapping must not
// strand the headline away from the label that introduces it.  Without marks,
// the same inline run has to survive having no sibling at all.
const stableShot = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02, threshold: 0.2 } as const;

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

test.use({ viewport: { width: 640, height: 420 }, locale: 'en-US' });

// The sentence gap.  NBSP + space survives some renderers, so \s covers it.
const LABEL = 'More Info.';
const HEADLINE = /DeepSeek, Muse, and MiniMax models through the Clutch bridge/;

test('visual: engine callout with three provider marks (Clutch)', async ({ page }) => {
  await page.goto('/?fixture=engine-callout');
  await pinFonts(page);

  const board = page.getByTestId('engine-callout-board');
  await expect(board).toBeVisible();

  const clutch = page.getByTestId('clutch-callout');
  await expect(clutch.getByText(LABEL, { exact: false })).toBeVisible();
  await expect(clutch.getByText(HEADLINE)).toBeVisible();

  // Three provider/model marks follow Clutch's own app mark on the row.
  await expect(clutch.getByTitle('DeepSeek models')).toBeVisible();
  await expect(clutch.getByTitle('Meta Muse models')).toBeVisible();
  await expect(clutch.getByTitle('MiniMax models')).toBeVisible();

  // The label and the headline must be one inline run:  no flex gap may land
  // between them, and the headline may not become a separate flex item that
  // wrapping can strand on its own line.  The encoding is structural — the
  // <strong> sits inside a <span> that also holds the headline text — because
  // a pixel diff would not tell you which of the two broke.
  const shape = await clutch.evaluate((root) => {
    const strong = Array.from(root.querySelectorAll('strong')).find(
      (node) => node.textContent?.trim() === 'More Info.',
    );
    const parent = strong?.parentElement;
    if (!parent) return null;
    return {
      tag: parent.tagName,
      // The headline is a text node inside that same parent.
      holdsHeadline: (parent.textContent ?? '').includes(
        'DeepSeek, Muse, and MiniMax models through the Clutch bridge',
      ),
    };
  });
  expect(shape, 'the label must sit inside an inline wrapper').not.toBeNull();
  expect(shape?.tag, 'label and headline share one inline box, not two flex items').toBe('SPAN');
  expect(shape?.holdsHeadline, 'that box also contains the headline text').toBe(true);

  await expect(clutch).toHaveScreenshot('engine-callout-two-marks.png', stableShot);
});

test('visual: engine callout with no provider marks (single brand)', async ({ page }) => {
  await page.goto('/?fixture=engine-callout');
  await pinFonts(page);

  const single = page.getByTestId('single-brand-callout');
  await expect(single.getByText(LABEL, { exact: false })).toBeVisible();
  await expect(single.getByText(/MiniMax's own coding CLI/)).toBeVisible();

  // No mark row at all in this shape, and the sentence still reads normally.
  await expect(single.getByTitle(/models$/)).toHaveCount(0);

  await expect(single).toHaveScreenshot('engine-callout-no-marks.png', stableShot);
});

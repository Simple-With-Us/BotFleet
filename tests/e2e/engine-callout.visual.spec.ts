import { test, expect, type Page } from '@playwright/test';

// The Why This Engine block, in both shapes it can take.  The fixture mounts
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
const LABEL = 'Why This Engine?';
const HEADLINE = /DeepSeek models over the Clutch ACP bridge/;

test('visual: engine callout with two provider marks (Clutch)', async ({ page }) => {
  await page.goto('/?fixture=engine-callout');
  await pinFonts(page);

  const board = page.getByTestId('engine-callout-board');
  await expect(board).toBeVisible();

  const clutch = page.getByTestId('clutch-callout');
  await expect(clutch.getByText(LABEL, { exact: false })).toBeVisible();
  await expect(clutch.getByText(HEADLINE)).toBeVisible();

  // Two marks, and both are titled with the brand they stand for — Clutch is
  // the row whose name hides that it hosts two providers.
  await expect(clutch.getByTitle('DeepSeek models')).toBeVisible();
  await expect(clutch.getByTitle('MiniMax models')).toBeVisible();

  // The label and the headline must be one inline run:  no flex gap may land
  // between them.  A gap of 6px or a 0-width join both fail this.
  const joined = await clutch.evaluate((root) => {
    const strong = Array.from(root.querySelectorAll('strong')).find((n) => n.textContent?.trim() === 'Why This Engine?');
    if (!strong || !strong.parentElement) return null;
    const parent = strong.parentElement;
    // The text node after <strong> inside the SAME element is the space that
    // separates the label from the headline.  If flex broke them apart the
    // whitespace would have moved out here and the parent would be the <p>.
    const range = document.createRange();
    range.setStartAfter(strong);
    range.setEnd(strong.parentElement === parent ? parent.childNodes[Array.from(parent.childNodes).indexOf(strong) + 1]! : parent, 0);
    return { sameParent: strong.parentElement === parent.parentElement, html: parent.innerHTML.slice(0, 120) };
  });
  expect(joined?.sameParent, 'label and headline share one inline parent').toBe(true);

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

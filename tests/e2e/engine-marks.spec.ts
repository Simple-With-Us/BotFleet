import { test, expect, type Page } from '@playwright/test';

// The model picker's engine rail, in the states that decide whether a platform
// logo reads as a logo or as an accent chip.  The fixture mounts the real rail
// at /?fixture=engine-marks (see src/main.tsx).
//
// Why this spec exists (owner, 2026-10-10): most logos in that rail were painted
// in the theme's accent colour, and the cause was invisible to the type checker.
// The check is therefore on the resolved colours, not on pixels: every painted
// mark in the rail must resolve to the mark token, and the mark token must
// never be the accent.  The second test paints the palette that produced the
// report — main text in the accent — so the regression cannot hide behind a skin
// that happens to look right.
//
// No `toHaveScreenshot` here on purpose.  The visual specs in this directory
// carry `-chromium-linux.png` baselines because CI runs them on Linux with
// pinned DejaVu fonts, and a baseline rendered on this Mac can never match
// those.  A spec that cannot ship a matching baseline must not ship an
// assertion that turns CI red on its first run; the resolved-colour assertions
// below are the platform-independent guard, and they fail on exactly the defect
// the screenshots would have shown.
test.use({ viewport: { width: 520, height: 460 }, locale: 'en-US' });

/** Every painted colour inside the rail, resolved by the browser. */
async function markColors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const tokens = {
      mark: root.getPropertyValue('--color-mark').trim(),
      ink: root.getPropertyValue('--color-ink').trim(),
      accent: root.getPropertyValue('--color-accent').trim(),
    };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d')!;
    const rgba = (hex: string): string => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = hex;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 ? 'transparent' : `${r},${g},${b},${a / 255}`;
    };
    const rail = document.querySelector('[data-testid="engine-marks-rail"]')!;
    const painted = new Set<string>();
    for (const node of rail.querySelectorAll('svg, svg *')) {
      const style = getComputedStyle(node);
      // Inside the SVG, the mark is paint: the fill, or the stroke for the
      // lucide-shaped marks (Box, Monitor), which is currentColor.
      const isSvg = node.namespaceURI === 'http://www.w3.org/2000/svg';
      const colour = isSvg ? (style.fill !== 'none' ? style.fill : style.stroke) : style.color;
      if (colour && colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') painted.add(rgba(colour));
    }
    // The monogram fallback is text, so its colour is what paints it.
    for (const node of rail.querySelectorAll('span')) {
      const colour = getComputedStyle(node).color;
      if (colour && colour !== 'rgba(0, 0, 0, 0)') painted.add(rgba(colour));
    }
    return [...painted].sort().concat(
      Object.entries(tokens).map(([name, hex]) => `${name}=${rgba(hex)}`),
    );
  });
}

test('engine marks: engine rail keeps every platform logo on the mark tone', async ({ page }) => {
  await page.goto('/?fixture=engine-marks&skin=atelier');
  const rail = page.getByTestId('engine-marks-rail');
  await expect(rail).toBeVisible();
  await expect(rail.getByTestId('engine-mark-grok')).toBeVisible();

  const resolved = await markColors(page);
  const tokens = Object.fromEntries(
    resolved.filter((line) => line.includes('=')).map((line) => line.split('=')),
  );
  // One tone for every mark, and it is the mark token.
  const painted = resolved.filter((line) => !line.includes('='));
  expect(painted.length).toBeGreaterThan(0);
  for (const colour of painted) expect(colour).toBe(tokens['mark']);
  // A preset skin happens to give marks the same tone as its text — that is the
  // design, not the bug.  What must never happen is the mark taking the accent,
  // and the third test covers the palette where the two tokens are told apart.
  expect(tokens['mark']).not.toBe(tokens['accent']);
});

test('engine marks: a palette whose main text is its accent still leaves logos neutral', async ({ page }) => {
  // The exact palette shape from the report:  main text painted in the accent.
  await page.goto('/?fixture=engine-marks&palette=hostile');
  const rail = page.getByTestId('engine-marks-rail');
  await expect(rail).toBeVisible();

  const resolved = await markColors(page);
  const tokens = Object.fromEntries(
    resolved.filter((line) => line.includes('=')).map((line) => line.split('=')),
  );
  // The palette really is the hostile one, or this test proves nothing.
  expect(tokens['ink']).toBe(tokens['accent']);
  expect(tokens['mark']).not.toBe(tokens['accent']);

  const painted = resolved.filter((line) => !line.includes('='));
  expect(painted.length).toBeGreaterThan(0);
  for (const colour of painted) expect(colour).toBe(tokens['mark']);
});

test('engine marks: the rail reads as one set in a dark skin', async ({ page }) => {
  await page.goto('/?fixture=engine-marks&skin=midnight');
  await expect(page.getByTestId('engine-marks-rail')).toBeVisible();

  const resolved = await markColors(page);
  const tokens = Object.fromEntries(
    resolved.filter((line) => line.includes('=')).map((line) => line.split('=')),
  );
  const painted = resolved.filter((line) => !line.includes('='));
  expect(painted.length).toBeGreaterThan(0);
  for (const colour of painted) expect(colour).toBe(tokens['mark']);
});
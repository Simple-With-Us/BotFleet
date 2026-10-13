import { test, expect, type Page } from '@playwright/test';

// The model picker's engine rail, in the states that decide whether a platform
// logo reads as a logo or as an accent chip.  The fixture mounts the real rail
// at /?fixture=engine-marks (see src/main.tsx).
//
// Why this spec exists (owner, 2026-10-10): most logos in that rail were painted
// in the theme's accent colour, and the cause was invisible to the type checker.
// The check is therefore on the resolved colours, not on pixels: every neutral
// mark in the rail must resolve to the mark token, and the mark token must
// never be the accent.  The hostile-palette test paints the palette that
// produced the report — main text in the accent — so the regression cannot hide
// behind a skin that happens to look right.
//
// Scope after the rebase onto #1047: the MiniMax tiles deliberately wear their
// fixed brand paint (red-to-orange gradient) so they read as logos rather than
// placeholders. Fixed paint is theme-proof by construction, so those tiles are
// pinned a different way — never the accent, and byte-identical across all
// three themes — instead of the mark-token assertion. Re-neutralising them is
// a product call for Jay, not a cleanup.
//
// No `toHaveScreenshot` here on purpose.  The visual specs in this directory
// carry `-chromium-linux.png` baselines because CI runs them on Linux with
// pinned DejaVu fonts, and a baseline rendered on this Mac can never match
// those.  A spec that cannot ship a matching baseline must not ship an
// assertion that turns CI red on its first run; the resolved-colour assertions
// below are the platform-independent guard, and they fail on exactly the defect
// the screenshots would have shown.
test.use({ viewport: { width: 520, height: 460 }, locale: 'en-US' });

/** Tiles that deliberately wear fixed brand paint (#1047), not the mark token. */
const BRAND_TILES = new Set(['engine-mark-minimax', 'engine-mark-mcode']);

interface RailColors {
  tokens: Record<string, string>;
  tiles: Record<string, string[]>;
}

/** Painted colours per rail tile, resolved by the browser. */
async function tileColors(page: Page): Promise<RailColors> {
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
    const tiles: Record<string, Set<string>> = {};
    const paint = (node: Element, colour: string | null) => {
      if (!colour || colour === 'rgba(0, 0, 0, 0)' || colour === 'transparent') return;
      const tile = node.closest('[data-testid^="engine-mark-"]')?.getAttribute('data-testid') ?? 'rail';
      (tiles[tile] ??= new Set()).add(rgba(colour));
    };
    for (const node of rail.querySelectorAll('svg, svg *')) {
      const style = getComputedStyle(node);
      // Inside the SVG, the mark is paint: the fill, or the stroke for the
      // lucide-shaped marks (Box, Monitor), which is currentColor.
      const isSvg = node.namespaceURI === 'http://www.w3.org/2000/svg';
      paint(node, isSvg ? (style.fill !== 'none' ? style.fill : style.stroke) : style.color);
    }
    // The monogram fallback is text, so its colour is what paints it.
    for (const node of rail.querySelectorAll('span')) {
      paint(node, getComputedStyle(node).color);
    }
    return {
      tokens: Object.fromEntries(Object.entries(tokens).map(([name, hex]) => [name, rgba(hex)])),
      tiles: Object.fromEntries(Object.entries(tiles).map(([tile, colours]) => [tile, [...colours].sort()])),
    };
  });
}

/** Every neutral tile resolves to exactly the mark token. */
function expectNeutralRail({ tokens, tiles }: RailColors) {
  expect(tokens['mark']).not.toBe(tokens['accent']);
  let seen = 0;
  for (const [tile, colours] of Object.entries(tiles)) {
    if (BRAND_TILES.has(tile)) continue;
    expect(colours.length, `${tile} painted nothing`).toBeGreaterThan(0);
    seen += 1;
    for (const colour of colours) expect(colour, `${tile} left the mark token`).toBe(tokens['mark']);
  }
  expect(seen).toBeGreaterThan(0);
}

/** Brand tiles never take the accent — the reported defect, in any theme. */
function expectBrandTilesOffAccent({ tokens, tiles }: RailColors) {
  for (const tile of BRAND_TILES) {
    const colours = tiles[tile] ?? [];
    expect(colours.length, `${tile} painted nothing`).toBeGreaterThan(0);
    for (const colour of colours) expect(colour, `${tile} took the accent`).not.toBe(tokens['accent']);
  }
}

test('engine marks: engine rail keeps neutral logos on the mark tone', async ({ page }) => {
  await page.goto('/?fixture=engine-marks&skin=atelier');
  const rail = page.getByTestId('engine-marks-rail');
  await expect(rail).toBeVisible();
  await expect(rail.getByTestId('engine-mark-grok')).toBeVisible();

  const resolved = await tileColors(page);
  expectNeutralRail(resolved);
  // A preset skin happens to give marks the same tone as its text — that is the
  // design, not the bug.  What must never happen is the mark taking the accent.
  expectBrandTilesOffAccent(resolved);
});

test('engine marks: a palette whose main text is its accent still leaves logos neutral', async ({ page }) => {
  // The exact palette shape from the report:  main text painted in the accent.
  await page.goto('/?fixture=engine-marks&palette=hostile');
  const rail = page.getByTestId('engine-marks-rail');
  await expect(rail).toBeVisible();

  const resolved = await tileColors(page);
  // The palette really is the hostile one, or this test proves nothing.
  expect(resolved.tokens['ink']).toBe(resolved.tokens['accent']);
  expect(resolved.tokens['mark']).not.toBe(resolved.tokens['accent']);

  expectNeutralRail(resolved);
  expectBrandTilesOffAccent(resolved);
});

test('engine marks: the rail reads as one set in a dark skin', async ({ page }) => {
  await page.goto('/?fixture=engine-marks&skin=midnight');
  await expect(page.getByTestId('engine-marks-rail')).toBeVisible();

  const resolved = await tileColors(page);
  expectNeutralRail(resolved);
  expectBrandTilesOffAccent(resolved);
});

test('engine marks: brand tiles are identical in every theme', async ({ page }) => {
  // Fixed brand paint cannot follow a palette by construction; this pins it —
  // a palette that could recolor a brand logo would show up here as drift.
  const byTheme: Record<string, RailColors> = {};
  for (const query of ['skin=atelier', 'skin=midnight', 'palette=hostile']) {
    await page.goto(`/?fixture=engine-marks&${query}`);
    await expect(page.getByTestId('engine-marks-rail')).toBeVisible();
    byTheme[query] = await tileColors(page);
  }
  for (const tile of BRAND_TILES) {
    expect(
      byTheme['skin=midnight'].tiles[tile],
      `${tile} drifted between light and dark skins`,
    ).toEqual(byTheme['skin=atelier'].tiles[tile]);
    expect(
      byTheme['palette=hostile'].tiles[tile],
      `${tile} followed the hostile palette`,
    ).toEqual(byTheme['skin=atelier'].tiles[tile]);
  }
});

import { test, expect, type Page } from '@playwright/test';

// The bot context menu's rows (src/components/Sidebar.tsx) sit on a `bg-card`
// surface.  A computed-style assertion is NOT enough here and would have passed
// straight through the bug: `hover:bg-raised/70` really does set a background
// colour, so `getComputedStyle` changes on hover even when the change is
// invisible.  In a light skin `--color-raised` and `--color-card` are both
// #ffffff, so the row paints white@70% over white.
//
// So this spec composites the hover fill over the surface in a canvas and
// asserts on the resulting pixel, which is what a person actually sees.
//
// The fixture mounts the real BotContextMenu, so reverting the class in
// Sidebar.tsx fails this test rather than quietly passing.

const LINUX_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

test.use({
  viewport: { width: 520, height: 520 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

/** A hover fill has to move the row off the menu surface by a step a person
 *  can see.  5/255 is deliberately below the intended fill (Studio paints
 *  #f1f3f5 on #ffffff, a 14/255 step) and far above anything that reads as
 *  noise.  A composite that lands on the surface exactly scores 0. */
const MIN_CHANNEL_STEP = 5;

type Row = { label: string; rest: string; hover: string; overSurface: string; step: number };

async function measureRows(page: Page): Promise<{ surface: string; rows: Row[] }> {
  return page.evaluate((minStep) => {
    const menu = document.querySelector('[data-bot-menu]');
    if (!menu) throw new Error('bot menu did not render');
    const buttons = Array.from(menu.querySelectorAll('button'));
    if (!buttons.length) throw new Error('bot menu rendered no rows');

    const surface = getComputedStyle(menu).backgroundColor;

    // Parse a computed colour into rgb + alpha.  Chromium resolves the
    // color-mix() Tailwind emits to `rgb(...)`/`rgba(...)`, but accept the
    // `color(srgb ...)` form too so the test does not depend on that.
    function parse(value: string): { rgb: [number, number, number]; a: number } {
      const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
      if (srgb) {
        return {
          rgb: [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255],
          a: srgb[4] === undefined ? 1 : Number(srgb[4]),
        };
      }
      const nums = value.match(/[\d.]+/g)?.map(Number);
      if (!nums || nums.length < 3) throw new Error(`unparsed colour: ${value}`);
      return { rgb: [nums[0], nums[1], nums[2]], a: nums[3] === undefined ? 1 : nums[3] };
    }

    // Composite `top` over `bottom` the way the compositor does, in a canvas,
    // so the number below is a painted pixel and not a restatement of the
    // CSS that produced the bug.
    function flatten(top: string, bottom: string): string {
      const t = parse(top);
      const b = parse(bottom);
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      ctx.fillStyle = `rgb(${b.rgb.map(Math.round).join(',')})`;
      ctx.fillRect(0, 0, 1, 1);
      if (t.a < 1) {
        ctx.globalAlpha = t.a;
        ctx.fillStyle = `rgb(${t.rgb.map(Math.round).join(',')})`;
        ctx.fillRect(0, 0, 1, 1);
      }
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return `rgb(${d[0]}, ${d[1]}, ${d[2]})`;
    }

    const rows: Row[] = [];
    for (const button of buttons) {
      if (button.disabled) continue; // a disabled row is painted muted on purpose
      const label = button.textContent?.trim() ?? '';
      const rest = getComputedStyle(button).backgroundColor;
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const hover = getComputedStyle(button).backgroundColor;
      const overSurface = flatten(hover, surface);
      const painted = parse(overSurface);
      const base = parse(surface);
      const step = Math.max(
        ...painted.rgb.map((channel, i) => Math.abs(channel - base.rgb[i])),
      );
      rows.push({ label, rest, hover, overSurface, step });
    }
    return { surface, rows };
  }, MIN_CHANNEL_STEP);
}

test.describe('bot context menu hover fill', () => {
  test('a hovered row is visibly distinct from the menu surface', async ({ page }) => {
    await page.goto('/?fixture=sidebar-menu');
    const menu = page.locator('[data-bot-menu]');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('menu-board')).toContainText('Remove Chief of Staff');

    const { surface, rows } = await measureRows(page);
    const invisible = rows.filter((row) => row.step < MIN_CHANNEL_STEP);

    // Reported in the failure so the numbers are auditable rather than asserted
    // blind: surface, the raw hover colour, and the composited step per row.
    expect(
      invisible.map((row) => ({
        label: row.label,
        surface,
        hover: row.hover,
        compositedOverSurface: row.overSurface,
        channelStep: row.step,
      })),
      'rows whose hover fill is indistinguishable from the menu surface',
    ).toEqual([]);

    // Nothing else here: Archive is intentionally disabled and is skipped above.
    expect(rows.length).toBeGreaterThan(4);
  });

  test('the same menu in a dark skin keeps a visible hover', async ({ page }) => {
    // Midnight gives --color-raised and --color-card different values, so the
    // old white@70% fill did show there.  This is the control: it proves the
    // failure above is about token pairing, not about the assertion being
    // unsatisfiable.
    await page.goto('/?fixture=sidebar-menu&skin=midnight');
    await page.evaluate(() => document.documentElement.setAttribute('data-skin', 'midnight'));
    const menu = page.locator('[data-bot-menu]');
    await expect(menu).toBeVisible();

    const { rows } = await measureRows(page);
    const invisible = rows.filter((row) => row.step < MIN_CHANNEL_STEP);
    expect(
      invisible.map((row) => ({ label: row.label, compositedOverSurface: row.overSurface, step: row.step })),
      'rows whose hover fill is indistinguishable in Midnight',
    ).toEqual([]);
  });

  test('visual: the menu rows, one hovered', async ({ page }) => {
    await page.goto('/?fixture=sidebar-menu');
    const menu = page.locator('[data-bot-menu]');
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: 'Duplicate' }).hover();
    await expect(menu).toHaveScreenshot('sidebar-menu-hover.png', { ...stableShot, maxDiffPixels: 0 });
  });
});
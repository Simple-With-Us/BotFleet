import { readFileSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';

// The bot context menu's rows (src/components/Sidebar.tsx) sit on a `bg-card`
// surface.  Reported bug: in the light skins `--color-raised` and `--color-card`
// are both #ffffff, so the old `hover:bg-raised/70` painted white over white
// and the hovered row did not change at all.
//
// A computed-style assertion would have passed straight through that bug:
// `hover:bg-raised/70` does set a background colour, so getComputedStyle
// changes on hover even when the change is invisible.  So this spec moves the
// real mouse onto each row (which sets the real :hover state, unlike a
// synthetic mouseover), takes a screenshot, and compares the painted pixel at
// rest with the painted pixel while hovered.  That is what a person sees.
//
// No screenshot baseline is used.  The check is a measured pixel step, so it
// needs no generated image and no tolerance of its own.
//
// It runs across every skin declared in src/styles.css, so a new skin that
// repeats the token pairing fails here too.

const LINUX_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

test.use({
  viewport: { width: 520, height: 520 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

/** A hover fill has to move the row off its resting colour by a step a person
 *  can see.  5/255 sits below the weakest intended fill in the current skins
 *  (14/255) and well above anything that reads as noise.  A fill that paints
 *  the resting colour exactly scores 0. */
const MIN_CHANNEL_STEP = 5;

// Every `[data-skin="x"]` block in the stylesheet, plus the default skin
// (no attribute).  Read from the source so the list cannot go stale.
const SKINS: string[] = [
  '',
  ...new Set(
    [...readFileSync('src/styles.css', 'utf8').matchAll(/^\[data-skin="([a-z0-9-]+)"\]\s*\{/gm)].map(
      (match) => match[1],
    ),
  ),
];

/** The painted RGB of a small patch at the right edge of `row`, which no icon
 *  or label reaches.  Decoded from a real screenshot, not from computed CSS. */
async function paintedPixel(page: Page, row: Locator): Promise<[number, number, number]> {
  const box = await row.boundingBox();
  if (!box) throw new Error('row has no box');
  const png = await page.screenshot({
    clip: { x: box.x + box.width - 24, y: box.y + 4, width: 12, height: Math.max(4, box.height - 8) },
    animations: 'disabled',
  });
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    const [r, g, b] = ctx.getImageData(2, 2, 1, 1).data;
    return [r, g, b] as [number, number, number];
  }, png.toString('base64'));
}

for (const skin of SKINS) {
  test(`bot context menu hover is visible in skin "${skin || 'default'}"`, async ({ page }) => {
    await page.goto('/?fixture=sidebar-menu');
    if (skin) await page.evaluate((name) => document.documentElement.setAttribute('data-skin', name), skin);
    const menu = page.locator('[data-bot-menu]');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('menu-board')).toContainText('Remove Chief of Staff');

    const rows = menu.locator('button:not([disabled])');
    const count = await rows.count();
    // Pin, Remove Chief of Staff, Move to Section, Mark as Unread, Edit Profile,
    // Duplicate, Copy Conversation ID, Delete.  Merge All and Archive are
    // disabled in this state and are painted muted on purpose.
    expect(count).toBeGreaterThan(5);

    const invisible: Array<{ label: string; rest: number[]; hovered: number[]; channelStep: number }> = [];
    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      const label = ((await row.textContent()) ?? '').trim();
      await page.mouse.move(2, 2);
      const rest = await paintedPixel(page, row);
      await row.hover();
      const hovered = await paintedPixel(page, row);
      const channelStep = Math.max(...rest.map((channel, c) => Math.abs(channel - hovered[c])));
      if (channelStep < MIN_CHANNEL_STEP) invisible.push({ label, rest, hovered, channelStep });
    }

    expect(invisible, 'rows whose real-mouse hover paints no visible change').toEqual([]);
  });
}

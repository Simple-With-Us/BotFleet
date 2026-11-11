import { join } from 'node:path';
import { test, expect, type Locator, type Page } from '@playwright/test';

// Karaoke on the reply itself, mid-reading, rendered by the real speaker,
// hook, ChatMarkdown and CSS.highlights via /?fixture=karaoke (see
// src/components/KaraokeVisualFixture.tsx).  The voice is a stand-in Audio
// element with a pinned clock, so the frame is the same every run; nothing
// talks to a harness.
// - The word being spoken is partly rolled in (accent color, faux-bold
//   shadow), the word before it trails off, and every other word keeps its
//   normal ink.
// - Light (the default) and dark (Midnight), each against a baseline.
// - A second moment in the reply (another word rolling in) and Reduce
//   Motion (whole words, no trail), checked through the highlight registry.
// - Every frame proves the ::highlight() styles paint: the bubble with the
//   highlights unregistered looks different.
// - The bubble is exactly as tall while reading as before: no re-flow.
// VERIFICATION_DIR=<dir> also writes each baseline frame there as a plain PNG.
const stableShot = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02, threshold: 0.2 } as const;

async function pinFonts(page: Page): Promise<void> {
  // The fixture pins the same fonts before its first layout; this keeps the
  // screenshot's fonts pinned even if the fixture changes.
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

test.use({ viewport: { width: 720, height: 560 }, locale: 'en-US' });

async function openMidReading(
  page: Page,
  { query = '', reducedMotion = 'no-preference' }: { query?: string; reducedMotion?: 'reduce' | 'no-preference' } = {},
) {
  // Nothing in this page may reach a real server: the fixture answers its own
  // audio requests, and anything else under /api is refused here.
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.emulateMedia({ reducedMotion });
  await page.goto(`/?fixture=karaoke${query}`);
  await pinFonts(page);
  const bubble = page.getByTestId('karaoke-bubble');
  await expect(bubble).toHaveAttribute('data-karaoke-ready', 'true');
  return bubble;
}

async function paintedState(page: Page) {
  return page.evaluate(() => {
    const read = (name: string) => {
      const highlight = CSS.highlights.get(name);
      return highlight ? [...highlight].map((range) => String(range)) : [];
    };
    return {
      current: read('karaoke-current'),
      trail: read('karaoke-trail'),
      ahead: read('karaoke-ahead'),
    };
  });
}

async function expectNoReflow(bubble: Locator): Promise<void> {
  const before = await bubble.getAttribute('data-height-before');
  const after = await bubble.getAttribute('data-height-after');
  expect(before).not.toBe('');
  expect(after).toBe(before);
}

/** The registry checks read CSS.highlights, not pixels, and the lit text is
 * a few hundred pixels of a bubble the baseline tolerates 2% of.  So also
 * prove the ::highlight() styles paint: the same bubble with the highlights
 * unregistered must look different.  The clock is pinned, so the frame loop
 * has nothing new to paint and does not put them back. */
async function expectHighlightPainted(page: Page, bubble: Locator): Promise<void> {
  const lit = await bubble.screenshot({ animations: 'disabled', caret: 'hide' });
  await page.evaluate(() => CSS.highlights.clear());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const plain = await bubble.screenshot({ animations: 'disabled', caret: 'hide' });
  expect(lit.equals(plain), 'the karaoke highlight paints nothing').toBe(false);
}

for (const theme of ['light', 'dark'] as const) {
  test(`visual: a reply mid-karaoke, highlighted on the message itself (${theme})`, async ({ page }) => {
    const bubble = await openMidReading(page, { query: theme === 'dark' ? '&theme=dark' : '' });

    const painted = await paintedState(page);
    // At 4.8 s into the first sentence "installer" is rolling in, and "the"
    // before it is still trailing off.
    expect(painted.current).toHaveLength(1);
    expect('installer'.startsWith(painted.current[0])).toBe(true);
    expect(painted.current[0].length).toBeGreaterThan(0);
    expect(painted.current[0].length).toBeLessThan('installer'.length);
    expect(painted.trail).toEqual(['the']);
    expect(painted.ahead).toEqual([]);
    await expectNoReflow(bubble);

    const name = `karaoke-mid-reply-${theme}.png`;
    if (process.env.VERIFICATION_DIR) await bubble.screenshot({ path: join(process.env.VERIFICATION_DIR, name) });
    await expect(bubble).toHaveScreenshot(name, stableShot);
    await expectHighlightPainted(page, bubble);
  });
}

test('karaoke: another moment in the reply rolls in its own word', async ({ page }) => {
  // 6.5 s: "ready" is rolling in, and "and" before it trails off.
  const bubble = await openMidReading(page, { query: '&t=6.5' });
  const painted = await paintedState(page);
  expect(painted.current).toHaveLength(1);
  expect(painted.current[0].length).toBeGreaterThan(0);
  expect(painted.current[0].length).toBeLessThan('ready'.length);
  expect('ready'.startsWith(painted.current[0])).toBe(true);
  expect(painted.trail).toEqual(['and']);
  expect(painted.ahead).toEqual([]);
  await expectNoReflow(bubble);
  await expectHighlightPainted(page, bubble);
});

test('karaoke: Reduce Motion lights the whole word, with no trail', async ({ page }) => {
  const bubble = await openMidReading(page, { reducedMotion: 'reduce' });
  const painted = await paintedState(page);
  // The same moment as the baseline frames: the whole word at once.
  expect(painted.current).toEqual(['installer']);
  expect(painted.trail).toEqual([]);
  expect(painted.ahead).toEqual([]);
  await expectNoReflow(bubble);
  await expectHighlightPainted(page, bubble);
});

import { test, expect, type Page } from '@playwright/test';

// Coverage for the model rows themselves, at the pane widths where the owner
// reported the defect (2026-10-11):  "Highspeed" and "DeepSeek-V" rendered one
// character per line, "MiniMax M3.1 Flash Preview" broke mid-slug, and a packed
// quota chip sat beside every name and pushed a horizontal scrollbar under the
// list.
//
// The assertions are GEOMETRY, not a screenshot alone: the failure mode was
// width arithmetic inside a flex row, and a picture of it is only as good as
// whoever looks at it.  These read the rendered boxes and check the two
// invariants directly — a name is one line and readable, and the tags move
// BELOW it rather than squeezing it.  The screenshot is kept as the record.

const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

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

/** One box per row: how wide the name rendered, how tall it rendered, and
 *  where the tags ended up relative to it. */
type RowGeometry = {
  label: string;
  labelWidth: number;
  labelHeight: number;
  oneLineHeight: number;
  tagsWidth: number;
  tagsBelowLabel: boolean;
  rowScrollWidth: number;
  rowClientWidth: number;
};

async function geometry(page: Page, column: string): Promise<RowGeometry[]> {
  return page.$$eval(
    `${column} [data-testid="model-row-label"]`,
    (labels) =>
      labels.map((label) => {
        const tags = label.parentElement?.querySelector('[data-testid="model-row-tags"]') as HTMLElement | null;
        const row = label.closest('button') as HTMLElement;
        const labelBox = label.getBoundingClientRect();
        const tagsBox = tags?.getBoundingClientRect();
        // The height one line of this font actually occupies, measured on the
        // element itself via its computed line box.  A name broken across lines
        // renders taller than this by a whole line per extra row.
        const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight) || labelBox.height;
        return {
          label: (label.textContent ?? '').trim(),
          labelWidth: Math.round(labelBox.width),
          labelHeight: Math.round(labelBox.height),
          oneLineHeight: Math.round(lineHeight),
          tagsWidth: tagsBox ? Math.round(tagsBox.width) : 0,
          // The whole tag group is a single wrapping unit, so this is either
          // clearly on the next line or clearly beside the name — never a
          // half-and-half split.
          tagsBelowLabel: tagsBox ? tagsBox.top >= labelBox.bottom - 2 : false,
          rowScrollWidth: row.scrollWidth,
          rowClientWidth: row.clientWidth,
        };
      }),
  );
}

test.use({ viewport: { width: 980, height: 460 }, locale: 'en-US' });

test.describe('model rows stay readable in a narrow picker', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-11T15:00:00Z'));
    await page.goto('/?fixture=model-rows');
    await pinFonts(page);
    // goto resolves on load, but the fixture route mounts after -- under CI
    // load, geometry() can run against an empty column and fail at the tags
    // assertion with "0 tagged rows", which reads as a layout defect in a
    // component that never rendered.  Wait for the mount instead.
    await page.waitForSelector('[data-testid="model-rows-narrow"] [data-testid="model-row-label"]');
    await page.waitForSelector('[data-testid="model-rows-wide"] [data-testid="model-row-label"]');
  });

  test('every slug renders on one line, at both widths', async ({ page }) => {
    for (const column of ['[data-testid="model-rows-wide"]', '[data-testid="model-rows-narrow"]']) {
      const rows = await geometry(page, column);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // One line, always: the label is `truncate`, so a taller box means the
        // text broke across lines inside it.
        expect(row.labelHeight, `${row.label} wraps at ${column}`).toBeLessThanOrEqual(row.oneLineHeight + 1);
        // And wide enough to read.  This is the assertion that would have
        // caught the original defect: the label collapsed to a handful of
        // pixels, which passes every "did it wrap" check.
        expect(row.labelWidth, `${row.label} is squeezed at ${column}`).toBeGreaterThan(100);
      }
    }
  });

  test('a narrow pane stacks the tags only for the names that need it', async ({ page }) => {
    const narrow = await geometry(page, '[data-testid="model-rows-narrow"]');
    // A precondition, not the assertion: if the column never mounted, the
    // failure below would blame the tags for rows that do not exist.
    expect(narrow.length, 'narrow column rendered no rows').toBeGreaterThan(0);
    const tagged = narrow.filter((row) => row.tagsWidth > 0);
    expect(tagged.length).toBeGreaterThan(0);

    // The two long slugs cannot share a 260px line with their tags, so the tags
    // go below — which is the point: the NAME stays whole instead of becoming a
    // column of letters.
    const long = tagged.filter((row) => row.label.startsWith('MiniMax M'));
    expect(long.length).toBeGreaterThan(0);
    for (const row of long) {
      expect(row.tagsBelowLabel, `${row.label} kept its tags on the name's line`).toBe(true);
    }

    // A shorter slug is not made worse by a second line it does not need, so
    // it keeps its tags inline even here.  Stacking everything would double the
    // height of the list to buy nothing.
    const short = tagged.filter((row) => row.label === 'Highspeed');
    expect(short.length).toBeGreaterThan(0);
    for (const row of short) {
      expect(row.tagsBelowLabel, 'Highspeed spent a second line it did not need').toBe(false);
    }

    // Whatever the tags do, the name never drops below its 9rem floor.  This is
    // the number that collapsed to a few pixels in the field.
    for (const row of narrow) {
      expect(row.labelWidth, `${row.label} lost its width floor`).toBeGreaterThanOrEqual(140);
    }
  });

  test('a wide pane still keeps the tags beside a name that fits', async ({ page }) => {
    const wide = await geometry(page, '[data-testid="model-rows-wide"]');
    const beside = wide.filter((row) => row.tagsWidth > 0 && !row.tagsBelowLabel);
    // At least one row must stay single-line: a layout where the tags drop
    // under EVERY name doubles the height of the list to buy nothing.
    expect(beside.length, 'every tagged row spent a second line').toBeGreaterThan(0);
    expect(
      beside.some((row) => row.label === 'Highspeed'),
      'the short slug lost its tags to a second line',
    ).toBe(true);
  });

  test('no row overflows its pane sideways', async ({ page }) => {
    for (const column of ['[data-testid="model-rows-wide"]', '[data-testid="model-rows-narrow"]']) {
      const rows = await geometry(page, column);
      for (const row of rows) {
        expect(row.rowScrollWidth, `${row.label} overflows at ${column}`).toBeLessThanOrEqual(row.rowClientWidth + 1);
      }
    }
  });

  test('usage reads once, above the list, not down the rows', async ({ page }) => {
    const board = await page.getByTestId('model-rows-board').innerText();
    expect(board).toContain('Usage');
    expect(board).toContain('67% left');
    expect(board).toContain('96% left');
    // The packed chip that used to sit on every row: it is what squeezed the
    // slug, so its absence is part of the fix, not a cosmetic change.
    expect(board).not.toContain('for 5h / w');
  });

  test('visual: model rows at both widths, with the usage block', async ({ page }) => {
    await expect(page.getByTestId('model-rows-board')).toHaveScreenshot('model-rows.png', {
      ...stableShot,
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
    });
  });
});
import { test, expect } from '@playwright/test';

// KanbanCommandCenter behaviour in a real browser, on the `flood` fixture of
// src/components/KanbanCommandCenterVisualFixture.tsx:  one routine that failed
// 38 times for the same cause, a routine whose twelve failures were all
// acknowledged on the Routines page, 19 other broken routines, and 20
// completed runs.  The board used to build one card for every one of them.
//
// Counts and text only, no screenshots:  the pixel baselines in
// kanban-command-center.visual.spec.ts cover the board's look, and this spec
// covers what a person sees when the history is long.  The fixture mounts the
// component straight onto a StoreContext, so nothing here reaches the network.

test('kanban: a long history becomes one card per routine and one page per column', async ({ page }) => {
  await page.goto('/?fixture=kanban-command-center&state=flood');

  const board = page.getByTestId('kanban-board');
  await expect(board).toBeVisible();
  await expect(board).toHaveAttribute('data-fixture-state', 'flood');

  const attention = page.getByTestId('kanban-column-attention');
  const completed = page.getByTestId('kanban-column-completed');
  const cards = (column: typeof attention) => column.getByRole('heading', { level: 4 });
  const showMore = (column: typeof attention) => column.getByRole('button', { name: /^Show \d+ More$/ });

  // 38 failures of one routine are one card, carrying the count of the rest.
  await expect(attention.getByRole('heading', { level: 4, name: 'GitHub UI Pass' })).toHaveCount(1);
  await expect(attention.getByText('+37 older')).toBeVisible();

  // Failures the owner already acknowledged do not queue at all.
  await expect(board.getByText('Acknowledged Nightly')).toHaveCount(0);

  // 20 cards in the Attention Queue (the flooded routine plus 19 others), 15
  // showing, and the header and badge still report the true 20.
  await expect(board.getByText('20 Needs Action')).toBeVisible();
  await expect(attention.getByText('20', { exact: true })).toBeVisible();
  await expect(cards(attention)).toHaveCount(15);
  await expect(showMore(attention)).toHaveText('Show 5 More');
  await expect(attention.getByText('5 hidden')).toBeVisible();

  // Every column is paged, not only Attention.
  await expect(cards(completed)).toHaveCount(15);
  await expect(showMore(completed)).toHaveText('Show 5 More');

  // Show More reveals the rest of that column and leaves the others alone.
  await showMore(attention).click();
  await expect(cards(attention)).toHaveCount(20);
  await expect(showMore(attention)).toHaveCount(0);
  await expect(cards(completed)).toHaveCount(15);
  await expect(showMore(completed)).toHaveCount(1);
});

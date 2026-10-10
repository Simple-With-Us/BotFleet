import { test, expect, type Page } from '@playwright/test';
import { z } from 'zod';

const QueuedSendBodySchema = z.object({ text: z.string().optional() });

// Visual coverage for the stacked queued steer pills (board b5146817).
//
// A busy conversation holds what the person typed but could not send yet, and
// each held message gets its own row above the composer: a MessageSquare
// glyph, the queued text as `queuedChipLabel` words it, and three actions —
// edit, cancel, steer now.  The rows stack instead of collapsing into one
// chip, so the layout that matters here is "many rows, composer still
// reachable", which no behavioural assertion would catch.
//
// The harness is the real app against a mocked server, the way
// composer-draft.spec.ts does it, because the pill's shape comes from the
// composer, the bot's busy flag and state.pendingQueued together.
//
// How the queue is built, which is the part worth writing down: a bot's
// pendingQueued never arrives from a GET.  The store fills it from the reply
// to the send (store.tsx `MessagePostResponseSchema` -> `pendingQueued`), so
// this spec drives it the way a person does — type into a busy conversation,
// press Enter, and let the server answer `queued: true` with a queueId.  A
// fake GET endpoint would have produced a spec that passes against a shape
// the product never uses.
//
// Every request is answered here and none reach a network: the preview server
// proxies /api to the local bot server, so the catch-all below is the guard
// against an unanswered route landing on a live install.
//
// Baseline regeneration is `pnpm exec playwright test
// tests/e2e/queued-steer-pills.visual.spec.ts --update-snapshots`.
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.
const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

const LINUX_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

test.use({
  viewport: { width: 900, height: 720 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

const QUEUE = 'thread-bot-steer';

const bot = {
  id: 'bot-steer',
  threadId: QUEUE,
  name: 'Steersman',
  title: '',
  description: '',
  notifications: true,
  color: 'blue',
  unread: false,
  busy: true,
  modelSelection: { instanceId: 'codex', model: 'gpt' },
  messages: [{ id: 'earlier', role: 'bot', kind: 'text', text: 'Working on it', at: 1_700_000_000_000 }],
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const json = (body: Json, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/** Answers the shell's startup surface, and takes every send on this busy bot
 * as queued: the exact answer `MessagePostResponseSchema` accepts, with the
 * queueId and threadId the store needs to open a pill.  Returns the sends the
 * server received, in order. */
async function mockServer(page: Page) {
  const sends: { text: string }[] = [];
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const post = pathname.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (pathname === '/api/events') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'retry: 250\n\ndata: {"kind":"hello","resumed":false}\n\n',
      });
    }
    if (pathname === '/api/bots' && method === 'GET') {
      return route.fulfill(json({ bots: [bot], groups: [], computerControl: {} }));
    }
    if (pathname.startsWith(`/api/bots/${bot.id}/queue`)) return route.fulfill(json({ ok: true }));
    if (pathname.startsWith(`/api/bots/${bot.id}/interrupt`)) return route.fulfill(json({ ok: true }));
    if (post && method === 'POST') {
      const body = QueuedSendBodySchema.parse(route.request().postDataJSON());
      sends.push({ text: body.text ?? '' });
      // No `replayed` key: MessagePostResponseSchema types it as
      // z.literal(true).optional() and is .strict(), so an explicit false is
      // not a valid answer and the store would treat this as a bad payload.
      return route.fulfill(
        json({ ok: true, queued: true, queueId: `q-${sends.length}`, threadId: QUEUE }, 202),
      );
    }
    if (pathname === '/api/instances') return route.fulfill(json({ instances: [], describedAt: Date.now() }));
    if (pathname === '/api/routines') return route.fulfill(json({ routines: [], runs: [] }));
    if (pathname === '/api/webhooks') return route.fulfill(json({ webhooks: [], attempts: [], ingress: {} }));
    if (pathname === '/api/resource-triggers') return route.fulfill(json({ triggers: [] }));
    if (pathname === '/api/jobs') return route.fulfill(json({ jobs: [] }));
    return route.fulfill(json({}));
  });
  return sends;
}

async function openBusyBot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
  await page.goto('/');
  await page.getByText(bot.name, { exact: true }).first().click();
  const box = page.getByRole('textbox', { name: `Message ${bot.name}` });
  await expect(box).toBeVisible();
  return box;
}

const ROOM_THREAD = 'thread-room-steer';
const ROOM_NAME = 'Writers Room';

const room = {
  id: 'room-steer',
  threadId: ROOM_THREAD,
  name: ROOM_NAME,
  memberIds: [bot.id],
  defaultResponder: { kind: 'member', botId: bot.id },
  bulletin: '',
  unread: false,
  createdAt: 1_700_000_000_000,
  busyBotId: bot.id,
  setupCompletedAt: 1_700_000_000_000,
  messages: [],
};

/** Answers the same startup surface as mockServer, but with a busy room on the
 * sidebar too.  A room's queued send is held client-side and never hits the
 * server while the room is busy, so this is allowed to answer 200 on /api/groups
 * sends without ever receiving one. */
async function mockServerWithRoom(page: Page) {
  const sends: { text: string }[] = [];
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const post = pathname.match(/^\/api\/bots\/([\w-]+)\/messages$/);
    if (pathname === '/api/events') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'retry: 250\n\ndata: {"kind":"hello","resumed":false}\n\n',
      });
    }
    if (pathname === '/api/bots' && method === 'GET') {
      return route.fulfill(json({ bots: [bot], groups: [room], computerControl: {} }));
    }
    if (pathname.startsWith(`/api/bots/${bot.id}/queue`)) return route.fulfill(json({ ok: true }));
    if (pathname.startsWith(`/api/bots/${bot.id}/interrupt`)) return route.fulfill(json({ ok: true }));
    if (pathname.startsWith(`/api/groups/${room.id}/interrupt`)) return route.fulfill(json({ ok: true, stopped: true }));
    if (post && method === 'POST') {
      const body = QueuedSendBodySchema.parse(route.request().postDataJSON());
      sends.push({ text: body.text ?? '' });
      return route.fulfill(
        json({ ok: true, queued: true, queueId: `q-${sends.length}`, threadId: QUEUE }, 202),
      );
    }
    if (pathname === '/api/instances') return route.fulfill(json({ instances: [], describedAt: Date.now() }));
    if (pathname === '/api/routines') return route.fulfill(json({ routines: [], runs: [] }));
    if (pathname === '/api/webhooks') return route.fulfill(json({ webhooks: [], attempts: [], ingress: {} }));
    if (pathname === '/api/resource-triggers') return route.fulfill(json({ triggers: [] }));
    if (pathname === '/api/jobs') return route.fulfill(json({ jobs: [] }));
    return route.fulfill(json({}));
  });
  return sends;
}

async function openBusyRoom(page: Page) {
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
  await page.goto('/');
  await page.getByText(ROOM_NAME, { exact: true }).first().click();
  const box = page.getByRole('textbox', { name: `Message ${ROOM_NAME}` });
  await expect(box).toBeVisible();
  return box;
}

/** Sends `text` into the busy conversation and waits for its pill. */
async function queueMessage(page: Page, box: ReturnType<typeof openBusyBot>, text: string, index: number) {
  await box.fill(text);
  await box.press('Enter');
  await expect(page.getByRole('button', { name: 'Edit queued message' })).toHaveCount(index);
}

test('visual: one queued steer pill carries its label and three actions', async ({ page }) => {
  const sends = await mockServer(page);
  const box = await openBusyBot(page);
  await pinFonts(page);

  await queueMessage(page, box, 'rerun the migration with the index dropped first', 1);
  expect(sends).toHaveLength(1);

  // The label states the wait and quotes what was typed.
  await expect(
    page.getByText(`Queued — sends when ${bot.name} finishes`, { exact: false }),
  ).toBeVisible();

  // Three actions ride the row: undo the queue, drop it, or send it now.
  await expect(page.getByRole('button', { name: 'Edit queued message' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Cancel queued message' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Steer Now' })).toHaveCount(1);

  // The row, not the Edit button: a screenshot of the button is a 24px
  // pencil that pins none of the layout this feature is about.  The label
  // span is a direct child of the row, so one level up from it is the row
  // itself — glyph, words and all three actions.
  const pillRow = page.locator('span[title^="Queued"]').first().locator('xpath=..');
  await expect(pillRow).toHaveScreenshot('composer-queued-pill.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});

test('visual: several queued pills stack without crowding out the composer', async ({ page }) => {
  const sends = await mockServer(page);
  const box = await openBusyBot(page);
  await pinFonts(page);

  await queueMessage(page, box, 'rerun the migration with the index dropped first', 1);
  await queueMessage(page, box, 'then check whether the backfill caught every row', 2);
  await queueMessage(page, box, 'and post the summary to the ops channel when it is done', 3);
  expect(sends).toHaveLength(3);

  // Each held message keeps its own row, carrying its own words.  The row
  // truncates long text with CSS, so the words are asserted through the
  // label's title attribute, which holds the full string either way.
  await expect(page.getByRole('button', { name: 'Edit queued message' })).toHaveCount(3);
  const labels = page.locator('span[title^="Queued"]');
  await expect(labels).toHaveCount(3);
  await expect(labels.nth(0)).toHaveAttribute('title', /index dropped first/);
  await expect(labels.nth(1)).toHaveAttribute('title', /backfill caught every row/);
  await expect(labels.nth(2)).toHaveAttribute('title', /ops channel when it is done/);

  // The composer stays usable underneath the stack.
  await expect(box).toBeVisible();
  await expect(box).toBeEditable();

  const stack = page.locator('span[title^="Queued"]').first().locator('xpath=../..');
  await expect(stack).toHaveScreenshot('composer-queued-pills.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});

test('visual: an empty queue shows no queued row at all', async ({ page }) => {
  await mockServer(page);
  const box = await openBusyBot(page);
  await pinFonts(page);

  await expect(box).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit queued message' })).toHaveCount(0);
});

test('visual: a queued message in a busy room shows the same pill row, with the group routing', async ({ page }) => {
  const sends = await mockServerWithRoom(page);
  const box = await openBusyRoom(page);
  await pinFonts(page);

  // The room is mid-turn; the message is held client-side and never POSTs.
  await queueMessage(page, box, 'rerun the migration with the index dropped first', 1);
  expect(sends).toHaveLength(0);

  await expect(page.getByRole('button', { name: 'Edit queued message' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Cancel queued message' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Steer Now' })).toHaveCount(1);

  const pillRow = page.locator('span[title^="Queued"]').first().locator('xpath=..');
  await expect(pillRow).toHaveScreenshot('composer-queued-pill-room.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});
import { test, expect, type Page, type Route } from '@playwright/test';

// A send the server refuses, or cannot be reached for, must not cost the
// person their message.  The composer clears the instant Enter is pressed (so
// a second Enter cannot send the same text twice) and hands the server's
// answer back to a restore step: a refusal puts the text, the attachment
// chips and the reply target back.
//
// Every request is answered here and none reach a network: the preview
// server proxies /api to the local bot server, so an unanswered route would
// land on a live install.  The catch-all below is the guard against that.

const bot = (id: string, name: string) => ({
  id,
  threadId: `thread-${id}`,
  name,
  title: '',
  description: '',
  notifications: true,
  color: 'blue',
  unread: false,
  modelSelection: { instanceId: 'codex', model: 'gpt' },
  messages: [{ id: `earlier-${id}`, role: 'bot', kind: 'text', text: 'An earlier answer to reply to', at: 1_700_000_000_000 }],
});
const DRAFTSMAN = bot('bot-draft', 'Draftsman');
const SECOND = bot('bot-second', 'Understudy');

/** A room whose member is mid-turn when `busy`, as the hydrate reports it. */
const room = (busy: boolean) => ({
  id: 'room-draft',
  threadId: 'thread-room-draft',
  name: 'Writers Room',
  memberIds: [DRAFTSMAN.id, SECOND.id],
  defaultResponder: { kind: 'member', botId: DRAFTSMAN.id },
  bulletin: '',
  unread: false,
  createdAt: 1_700_000_000_000,
  busyBotId: busy ? DRAFTSMAN.id : null,
  setupCompletedAt: 1_700_000_000_000,
  messages: [],
});

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const json = (body: Json, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

type Sent = { botId: string; text: string; replyToId?: string };

/** What the page sees of the room: whether its member is mid-turn right now. */
const roomState = { busy: false };

/** Answers the whole /api surface the shell reads at startup, and hands each
 * bot or room send to `onSend`.  Returns the sends the server received, in
 * order.  The event stream says hello and ends, which makes the page read
 * the roster again each time it reconnects. */
async function mockServer(page: Page, onSend: (route: Route, attempt: number) => Promise<void> | void) {
  const sends: Sent[] = [];
  roomState.busy = false;
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    const send = pathname.match(/^\/api\/(?:bots|groups)\/([\w-]+)\/messages$/);
    if (pathname === '/api/events') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'retry: 250\n\ndata: {"kind":"hello","resumed":false}\n\n',
      });
    }
    if (pathname === '/api/bots' && method === 'GET') {
      return route.fulfill(json({ bots: [DRAFTSMAN, SECOND], groups: [room(roomState.busy)], computerControl: {} }));
    }
    if (pathname === `/api/groups/${room(false).id}/interrupt`) return route.fulfill(json({ ok: true, stopped: true }));
    if (send && method === 'POST') {
      sends.push({ botId: send[1], ...route.request().postDataJSON() });
      return onSend(route, sends.length);
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

const refuse = (route: Route) => route.fulfill(json({ error: 'text required' }, 400));
const accept = (route: Route) => route.fulfill(json({ ok: true }, 202));

/** A reply the test releases when it decides the server has answered. */
function held() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  return { released, release };
}

async function openApp(page: Page) {
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
  await page.goto('/');
}

async function openBot(page: Page, name: string) {
  await page.getByText(name, { exact: true }).first().click();
  const box = page.getByRole('textbox', { name: `Message ${name}` });
  await expect(box).toBeVisible();
  return box;
}

test('a send the server refuses puts the message back in the box', async ({ page }) => {
  const sends = await mockServer(page, refuse);
  await openApp(page);
  const box = await openBot(page, DRAFTSMAN.name);

  await box.fill('a long prompt that took a while to write');
  await box.press('Enter');

  await expect.poll(() => sends.length).toBe(1);
  await expect(box).toHaveValue('a long prompt that took a while to write');
});

test('a server that cannot be reached gives the message back too', async ({ page }) => {
  const sends = await mockServer(page, (route) => route.abort('connectionrefused'));
  await openApp(page);
  const box = await openBot(page, DRAFTSMAN.name);

  await box.fill('written while the server was restarting');
  await box.press('Enter');

  await expect.poll(() => sends.length).toBe(1);
  await expect(box).toHaveValue('written while the server was restarting');
});

test('an accepted send leaves the box empty and goes out once', async ({ page }) => {
  const sends = await mockServer(page, accept);
  await openApp(page);
  const box = await openBot(page, DRAFTSMAN.name);

  await box.fill('send me once');
  await box.press('Enter');
  await box.press('Enter');

  await expect(box).toHaveValue('');
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0]).toMatchObject({ botId: DRAFTSMAN.id, text: 'send me once' });
});

test('a slow answer that is a success does not bring the message back', async ({ page }) => {
  const answer = held();
  const sends = await mockServer(page, async (route) => {
    await answer.released;
    await accept(route);
  });
  await openApp(page);
  const box = await openBot(page, DRAFTSMAN.name);

  await box.fill('slow but fine');
  await box.press('Enter');
  await expect.poll(() => sends.length).toBe(1);
  answer.release();

  // the box must stay empty after the late 202
  await page.waitForTimeout(300);
  await expect(box).toHaveValue('');
});

test('a slow refusal keeps what was typed meanwhile, with the failed message ahead of it', async ({ page }) => {
  const answer = held();
  const sends = await mockServer(page, async (route) => {
    await answer.released;
    await refuse(route);
  });
  await openApp(page);
  const box = await openBot(page, DRAFTSMAN.name);

  await box.fill('the message that fails');
  await box.press('Enter');
  await expect.poll(() => sends.length).toBe(1);
  await box.fill('typed while it was in flight');
  answer.release();

  await expect(box).toHaveValue('the message that fails\n\ntyped while it was in flight');
});

test('a message refused after the person switched bots is waiting when they come back', async ({ page }) => {
  const answer = held();
  const sends = await mockServer(page, async (route) => {
    await answer.released;
    await refuse(route);
  });
  await openApp(page);
  const box = await openBot(page, DRAFTSMAN.name);

  await box.fill('sent just before leaving');
  await box.press('Enter');
  await expect.poll(() => sends.length).toBe(1);

  const other = await openBot(page, SECOND.name);
  await expect(other).toHaveValue('');
  answer.release();
  // the other bot's box is untouched by a refusal that belongs to the first
  await page.waitForTimeout(300);
  await expect(other).toHaveValue('');

  const back = await openBot(page, DRAFTSMAN.name);
  await expect(back).toHaveValue('sent just before leaving');
});

test('a refused send brings back its pasted text and the message it replied to', async ({ page }) => {
  const answer = held();
  const sends = await mockServer(page, async (route) => {
    await answer.released;
    await refuse(route);
  });
  await openApp(page);
  const box = await openBot(page, DRAFTSMAN.name);
  const replyQuote = page.getByText('Replying to', { exact: false });
  const chip = page.getByRole('button', { name: 'Remove pasted text' });

  await page.getByRole('button', { name: 'Reply to Message' }).first().click({ force: true });
  await expect(replyQuote).toBeVisible();

  // a long paste becomes a chip rather than text in the box
  await box.evaluate((field, long) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', long);
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, 'a pasted line of an enormous log\n'.repeat(60));
  await expect(chip).toBeVisible();

  await box.fill('what do you make of this log?');
  await box.press('Enter');

  // out the door: the composer is clear while the server thinks about it
  await expect.poll(() => sends.length).toBe(1);
  expect(sends[0].replyToId).toBe(`earlier-${DRAFTSMAN.id}`);
  await expect(box).toHaveValue('');
  await expect(chip).toBeHidden();
  await expect(replyQuote).toBeHidden();

  answer.release();
  await expect(box).toHaveValue('what do you make of this log?');
  await expect(chip).toBeVisible();
  await expect(replyQuote).toBeVisible();
});

async function openRoom(page: Page) {
  await page.getByText('Writers Room', { exact: true }).first().click();
  const box = page.getByRole('textbox', { name: 'Message Writers Room', exact: false });
  await expect(box).toBeVisible();
  return box;
}

test('Steer Now in a busy room gives the message back when the server refuses it', async ({ page }) => {
  const sends = await mockServer(page, refuse);
  roomState.busy = true;
  await openApp(page);
  const box = await openRoom(page);

  await box.fill('interrupt with this instead');
  await box.press('Alt+Enter');

  await expect.poll(() => sends.length).toBe(1);
  await expect(box).toHaveValue('interrupt with this instead');
});

test('a room message held for a busy member is given back if the server refuses it once the room settles', async ({ page }) => {
  const sends = await mockServer(page, refuse);
  roomState.busy = true;
  await openApp(page);
  const box = await openRoom(page);

  await box.fill('queued behind the member who is talking');
  await box.press('Enter');
  // held in the composer's queue: nothing has gone to the server yet
  await expect(box).toHaveValue('');
  expect(sends).toHaveLength(0);

  roomState.busy = false;
  await expect.poll(() => sends.length).toBe(1);
  await expect(box).toHaveValue('queued behind the member who is talking');
});

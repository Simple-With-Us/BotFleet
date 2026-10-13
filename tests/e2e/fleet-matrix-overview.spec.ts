import { expect, test, type Page } from '@playwright/test';

// The Fleet Matrix overview covers the chat pane.  It opens from the "All" tab
// and closes when the person picks a chat, and for nothing else.  Shell used to
// close it from an effect that also watched `state.bots`, `state.groups`,
// `viewedThreadId` and `selectedAppId`, so a streamed bot update, or the "All"
// tab while a room was open, shut it the moment it opened.  These checks run
// the real app against a mocked harness and assert on the DOM only.
//
// The event stream is replaced by a fake EventSource so a test can push frames
// into the page after it has loaded; a canned `route.fulfill` body cannot.
// Every /api request is fulfilled here.  Vite preview proxies unknown /api
// calls to the running harness, so the catch-all must never fall through.
const NOW = 1_700_000_000_000;
const ATLAS = 'bot-atlas';
const BOREALIS = 'bot-borealis';
const ROOM = 'group-orion';

type Frame =
  | { kind: 'hello'; resumed: boolean }
  | { kind: 'bot'; bot: ReturnType<typeof bot> }
  | { kind: 'group'; group: { id: string; bulletin: string } };

declare global {
  interface Window {
    __pushFrame?: (frame: Frame) => void;
  }
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const json = (body: Json) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function bot(id: string, name: string, extra: { busy?: boolean; activity?: 'working' } = {}) {
  return {
    id,
    threadId: `thread-${id}`,
    name,
    title: '',
    description: '',
    notifications: true,
    color: 'blue',
    unread: false,
    busy: false,
    cwd: '/fixture/bots',
    modelSelection: { instanceId: 'codex', model: 'gpt' },
    tasks: [{ threadId: `thread-${id}`, title: 'Thread', createdAt: NOW }],
    messages: [],
    ...extra,
  };
}

function room() {
  return {
    id: ROOM,
    name: 'Orion App',
    threadId: `thread-${ROOM}`,
    memberIds: [ATLAS, BOREALIS],
    defaultResponder: { kind: 'member', botId: ATLAS },
    bulletin: '',
    unread: false,
    createdAt: NOW,
    setupCompletedAt: NOW,
    messages: [],
    cwd: '/fixture/orion',
  };
}

async function mockHarness(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('omb-email-gate', 'skipped');
    class FakeEventSource {
      static open: FakeEventSource[] = [];
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      readyState = 1;
      withCredentials = false;
      constructor(readonly url: string) {
        FakeEventSource.open.push(this);
        // The store assigns its handlers right after construction.  A first
        // hello with resumed:false is what makes it hydrate from REST.
        setTimeout(() => {
          this.onopen?.(new Event('open'));
          this.push({ kind: 'hello', resumed: false });
        }, 0);
      }
      push(frame: Frame) {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
      }
      close() {
        this.readyState = 2;
      }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return true;
      }
    }
    Object.assign(window, {
      EventSource: FakeEventSource,
      __pushFrame: (frame: Frame) => FakeEventSource.open.forEach((source) => source.push(frame)),
    });
  });

  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/bots') {
      return route.fulfill(json({
        bots: [bot(ATLAS, 'Atlas'), bot(BOREALIS, 'Borealis')],
        groups: [room()],
        computerControl: {},
      }));
    }
    if (pathname === '/api/instances') {
      return route.fulfill(json({
        instances: [{
          instanceId: 'codex', driverKind: 'codex', displayName: 'Codex',
          enabled: true, snapshot: { state: 'available', authenticated: true },
          models: { default: 'gpt', options: [{ id: 'gpt', label: 'GPT' }] },
        }],
        describedAt: Date.now(),
      }));
    }
    if (pathname === '/api/config') return route.fulfill(json({ conversationMode: 'projects', terminology: 'apps' }));
    if (pathname === '/api/routines') return route.fulfill(json({ routines: [], runs: [] }));
    if (pathname === '/api/webhooks') return route.fulfill(json({ webhooks: [], attempts: [], ingress: {} }));
    if (pathname === '/api/resource-triggers') return route.fulfill(json({ triggers: [] }));
    if (pathname === '/api/jobs') return route.fulfill(json({ jobs: [] }));
    return route.fulfill(json({}));
  });
}

function pushFrame(page: Page, frame: Frame) {
  return page.evaluate((payload) => window.__pushFrame?.(payload), frame);
}

const overview = (page: Page) => page.getByRole('heading', { name: /Fleet Matrix/ });
const deck = (page: Page) => page.getByLabel('App Deck Navigation');
const sidebarRow = (page: Page, name: string) =>
  page.getByRole('complementary', { name: 'Bots and Navigation' }).getByText(name, { exact: true }).first();

// Atlas is the first bot, so hydrate opens its chat.  "New Thread" lives in
// ChatView only, so it is the sign that the chat pane, not the overview, is up.
async function openApp(page: Page) {
  await mockHarness(page);
  await page.goto('/');
  await expect(sidebarRow(page, 'Atlas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New Thread' })).toBeVisible();
}

async function openOverview(page: Page) {
  await deck(page).getByRole('button', { name: /Matrix Overview/ }).click();
  await expect(overview(page)).toBeVisible();
}

// A negative needs a window.  The old effect closed the overview one render
// after the update that triggered it.
async function expectStillOpen(page: Page) {
  await page.waitForTimeout(400);
  await expect(overview(page)).toBeVisible();
}

test('a streamed bot or room update leaves the overview open', async ({ page }) => {
  await openApp(page);
  await openOverview(page);

  await pushFrame(page, { kind: 'bot', bot: bot(ATLAS, 'Atlas', { busy: true, activity: 'working' }) });
  await pushFrame(page, { kind: 'group', group: { id: ROOM, bulletin: 'Standup moved to 3pm' } });

  // The rollup badge is the store's update reaching the screen.
  await expect(deck(page).getByTitle(/^1 bots? working$/)).toBeVisible();
  await expectStillOpen(page);
});

test('choosing All while a room is open shows the overview and keeps it', async ({ page }) => {
  await openApp(page);
  await deck(page).getByRole('button', { name: /Orion App/ }).first().click();
  await expect(deck(page).getByRole('button', { name: 'Orion App Team Chat' })).toBeVisible();

  await openOverview(page);
  await expectStillOpen(page);
});

test('picking the chat that is already open in the sidebar closes the overview', async ({ page }) => {
  await openApp(page);
  await openOverview(page);
  await expect(page.getByRole('button', { name: 'New Thread' })).toHaveCount(0);

  // Same bot as before the overview opened: selectedId does not change, so
  // only a counted pick can close it.
  await sidebarRow(page, 'Atlas').click();
  await expect(overview(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Thread' })).toBeVisible();
});

test('picking another bot in the sidebar, or pressing a shortcut, closes the overview', async ({ page }) => {
  await openApp(page);

  await openOverview(page);
  await sidebarRow(page, 'Borealis').click();
  await expect(overview(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Thread' })).toBeVisible();

  await openOverview(page);
  await page.keyboard.press('Control+1');
  await expect(overview(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New Thread' })).toBeVisible();
});

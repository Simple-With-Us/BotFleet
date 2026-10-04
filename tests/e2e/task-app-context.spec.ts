import { expect, test, type Page } from '@playwright/test';
import type { TaskWorkspaceContext } from '../../shared/task-workspace-context';

declare global {
  interface Window {
    __taskMenuAction?: (action: string) => void;
  }
}

// Every /api request is fulfilled here.  Vite preview proxies unknown /api
// calls to the running harness, so the catch-all must never fall through.
const BOT_ID = 'bot-atlas';
const APP_ID = 'group-orion';
const APP_NAME = 'Orion App';
const APP_FOLDER = '/fixture/orion/service';
const SAVED_FOLDER = '/canonical/orion/service';
const OLD_THREAD = 'thread-atlas-old';
const NEW_THREAD = 'thread-atlas-new';
const NOW = 1_700_000_000_000;

type AppRef = { kind: 'group'; id: string };
type PostBody = { appRef?: AppRef };

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

function group(id: string, name: string, memberIds: string[], options: { cwd?: string; pinnedCwd?: string; dm?: boolean } = {}) {
  return {
    id,
    name,
    threadId: `thread-${id}`,
    memberIds,
    defaultResponder: { kind: 'member', botId: BOT_ID },
    bulletin: '',
    unread: false,
    createdAt: NOW,
    setupCompletedAt: NOW,
    messages: [],
    ...options,
  };
}

function bot(busy = false) {
  return {
    id: BOT_ID,
    threadId: OLD_THREAD,
    name: 'Atlas',
    title: '',
    description: '',
    notifications: true,
    color: 'blue',
    unread: false,
    busy,
    cwd: '/fixture/bot-default',
    modelSelection: { instanceId: 'codex', model: 'gpt' },
    tasks: [{ threadId: OLD_THREAD, title: 'Previous Thread', createdAt: NOW }],
    messages: [],
  };
}

async function mockServer(page: Page, options: { eligible?: boolean; busy?: boolean; conversationMode?: 'projects' | 'simple' } = {}) {
  const posts: PostBody[] = [];
  const fixture = {
    bot: bot(options.busy),
    groups: [
      ...(options.eligible === false ? [] : [group(APP_ID, APP_NAME, [BOT_ID], { cwd: APP_FOLDER })]),
      group('group-dm', 'Private DM', [BOT_ID], { dm: true, cwd: '/fixture/dm' }),
      group('group-nonmember', 'Other Bot App', ['bot-elsewhere'], { cwd: '/fixture/other' }),
      group('group-no-folder', 'No Folder App', [BOT_ID], { pinnedCwd: '/fixture/pinned-only' }),
    ],
    posts,
  };

  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === '/api/events') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        // A new browser fixture has no resumable event cursor.  The app must
        // load its REST snapshot before the bot row can be selected.
        body: 'retry: 30000\n\ndata: {"kind":"hello","resumed":false}\n\n',
      });
    }
    if (pathname === '/api/bots' && method === 'GET') {
      return route.fulfill(json({ bots: [fixture.bot], groups: fixture.groups, computerControl: {} }));
    }
    if (pathname === `/api/bots/${BOT_ID}/tasks` && method === 'POST') {
      // SAFETY: This route receives only the fixture's task-create request.
      // Each test checks the exact recorded body after the action.
      const body = route.request().postDataJSON() as PostBody;
      fixture.posts.push(body);
      const workspaceContext = body.appRef
        ? { kind: 'local' as const, appRef: body.appRef, cwd: SAVED_FOLDER, capturedAt: NOW + 100 }
        : undefined;
      const createdTask: { threadId: string; title: string; createdAt: number; cwd?: string; workspaceContext?: TaskWorkspaceContext } = {
        threadId: NEW_THREAD,
        title: 'New Thread',
        createdAt: NOW + 100,
      };
      if (workspaceContext) {
        createdTask.cwd = SAVED_FOLDER;
        createdTask.workspaceContext = workspaceContext;
      }
      fixture.bot = {
        ...fixture.bot,
        threadId: NEW_THREAD,
        tasks: [
          createdTask,
          ...fixture.bot.tasks.filter((task) => task.threadId !== NEW_THREAD),
        ],
        messages: [],
      };
      return route.fulfill(json({ bot: fixture.bot }));
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
    if (pathname === '/api/config') return route.fulfill(json({ conversationMode: options.conversationMode ?? 'projects', terminology: 'apps' }));
    if (pathname === '/api/routines') return route.fulfill(json({ routines: [], runs: [] }));
    if (pathname === '/api/webhooks') return route.fulfill(json({ webhooks: [], attempts: [], ingress: {} }));
    if (pathname === '/api/resource-triggers') return route.fulfill(json({ triggers: [] }));
    if (pathname === '/api/jobs') return route.fulfill(json({ jobs: [] }));
    return route.fulfill(json({}));
  });
  return fixture;
}

async function openBot(page: Page, expectNewButton = true) {
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
  await page.goto('/');
  const botRow = page.getByRole('complementary', { name: 'Bots and Navigation' }).getByText('Atlas', { exact: true }).first();
  await expect(botRow).toBeVisible();
  await botRow.click();
  if (expectNewButton) await expect(page.getByRole('button', { name: 'New Thread' })).toBeVisible();
}

function watchBrowserErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test('choosing an App saves its server snapshot and retains the folder after defaults change or the App disappears', async ({ page }, testInfo) => {
  const errors = watchBrowserErrors(page);
  const fixture = await mockServer(page);
  await openBot(page);

  await page.getByRole('button', { name: 'New Thread' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Thread' });
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Unassigned' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Orion App.*Folder:/ })).toBeVisible();
  await expect(dialog.getByText(APP_FOLDER, { exact: true })).toBeVisible();
  for (const hidden of ['Private DM', 'Other Bot App', 'No Folder App', '/fixture/pinned-only']) {
    await expect(dialog.getByText(hidden, { exact: true })).toHaveCount(0);
  }
  const chooserScreenshot = testInfo.outputPath('task-app-context-chooser.png');
  await page.screenshot({ path: chooserScreenshot, fullPage: true });
  await testInfo.attach('task-app-context-chooser', { path: chooserScreenshot, contentType: 'image/png' });

  await dialog.getByRole('button', { name: /Orion App.*Folder:/ }).click();
  await expect.poll(() => fixture.posts).toEqual([{ appRef: { kind: 'group', id: APP_ID } }]);
  await expect(dialog).toHaveCount(0);
  const savedLabel = page.getByLabel(`Saved App: ${APP_NAME}.  Folder: ${SAVED_FOLDER}`);
  await expect(savedLabel).toBeVisible();
  await expect(savedLabel).toContainText(SAVED_FOLDER);
  await expect(page.getByRole('tablist', { name: 'Threads' })).toContainText('New Thread');
  const desktopScreenshot = testInfo.outputPath('task-app-context-desktop.png');
  await page.screenshot({ path: desktopScreenshot, fullPage: true });
  await testInfo.attach('task-app-context-desktop', { path: desktopScreenshot, contentType: 'image/png' });

  fixture.groups[0] = group(APP_ID, APP_NAME, [BOT_ID], { cwd: '/fixture/orion/moved' });
  fixture.bot.cwd = '/fixture/bot-moved';
  await page.reload();
  await expect(savedLabel).toBeVisible();
  await expect(savedLabel).toContainText(SAVED_FOLDER);
  await expect(savedLabel).not.toContainText('/fixture/orion/moved');

  fixture.groups = fixture.groups.filter((entry) => entry.id !== APP_ID);
  await page.reload();
  const unavailable = page.getByLabel(`Saved App: Unavailable App (${APP_ID}).  Folder: ${SAVED_FOLDER}`);
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toContainText(APP_ID);
  await expect(unavailable).toContainText(SAVED_FOLDER);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(unavailable).toBeVisible();
  try {
    await expect.poll(
      () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      { timeout: 5_000, message: 'The document should not overflow the narrow viewport.' },
    ).toBe(true);
  } finally {
    const narrowScreenshot = testInfo.outputPath('task-app-context-narrow.png');
    await page.screenshot({ path: narrowScreenshot, fullPage: true });
    await testInfo.attach('task-app-context-narrow', { path: narrowScreenshot, contentType: 'image/png' });
    const geometry = await page.evaluate(() => {
      const viewportWidth = window.innerWidth;
      const overflowing = Array.from(document.querySelectorAll('*'))
        .flatMap((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          if (
            style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 ||
            rect.width === 0 || rect.height === 0 || rect.right <= viewportWidth + 1
          ) return [];
          return [{
            tag: element.tagName.toLowerCase(),
            classes: element.getAttribute('class') ?? '',
            boundingRect: {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
          }];
        })
        .sort((left, right) => right.boundingRect.right - left.boundingRect.right)
        .slice(0, 15);
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        document: {
          width: document.documentElement.scrollWidth,
          height: document.documentElement.scrollHeight,
        },
        overflowingVisibleElements: overflowing,
      };
    });
    await testInfo.attach('task-app-context-overflow-geometry', {
      body: JSON.stringify(geometry, null, 2),
      contentType: 'application/json',
    });
  }
  await expect(page.locator('vite-error-overlay, #webpack-dev-server-client-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Unassigned sends no App reference and shows no workspace label', async ({ page }) => {
  const fixture = await mockServer(page);
  await openBot(page);
  await page.getByRole('button', { name: 'New Thread' }).click();
  await page.getByRole('dialog', { name: 'New Thread' }).getByRole('button', { name: 'Unassigned' }).click();

  await expect.poll(() => fixture.posts).toEqual([{}]);
  await expect(page.getByRole('dialog', { name: 'New Thread' })).toHaveCount(0);
  await expect(page.locator('[aria-label^="Saved App:"]')).toHaveCount(0);
});

test('without eligible Apps New Thread creates directly', async ({ page }) => {
  const fixture = await mockServer(page, { eligible: false });
  await openBot(page);
  await page.getByRole('button', { name: 'New Thread' }).click();

  await expect.poll(() => fixture.posts).toEqual([{}]);
  await expect(page.getByRole('dialog', { name: 'New Thread' })).toHaveCount(0);
});

async function installNativeMenuStub(page: Page) {
  await page.addInitScript(() => {
    let menuAction: ((action: string) => void) | undefined;
    Object.defineProperty(window, 'ogb', {
      configurable: true,
      value: {
        onMenuAction(callback: (action: string) => void) {
          menuAction = callback;
          return () => { if (menuAction === callback) menuAction = undefined; };
        },
      },
    });
    window.__taskMenuAction = (action) => menuAction?.(action);
  });
}

async function triggerNativeNewThread(page: Page) {
  await page.evaluate(() => window.__taskMenuAction?.('new-task'));
}

test('repeated native New Thread actions keep the chooser focused and protect the old draft', async ({ page }) => {
  await installNativeMenuStub(page);
  const fixture = await mockServer(page);
  await openBot(page);
  const composer = page.getByRole('textbox', { name: 'Message Atlas' });
  await composer.fill('draft stays in the old conversation');

  await triggerNativeNewThread(page);
  const dialog = page.getByRole('dialog', { name: 'New Thread' });
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: /Orion App.*Folder:/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Unassigned' })).toBeFocused();

  await triggerNativeNewThread(page);
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByRole('button', { name: 'Unassigned' })).toBeFocused();
  // Space and Enter should activate a focused choice, so keep this probe to letters.
  await page.keyboard.type('shouldnotreachcomposer');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Unassigned' })).toBeFocused();
  await expect(composer).toHaveValue('draft stays in the old conversation');
  expect(fixture.posts).toHaveLength(0);
});

test('native New Thread is inert in Simple mode', async ({ page }) => {
  await installNativeMenuStub(page);
  const fixture = await mockServer(page, { conversationMode: 'simple' });
  await openBot(page, false);
  await expect(page.getByRole('button', { name: 'New Thread' })).toHaveCount(0);

  await triggerNativeNewThread(page);
  await page.waitForTimeout(250);
  await expect(page.getByRole('dialog', { name: 'New Thread' })).toHaveCount(0);
  expect(fixture.posts).toHaveLength(0);
});

test('a busy bot cannot start another thread', async ({ page }) => {
  const fixture = await mockServer(page, { busy: true });
  await openBot(page);

  await expect(page.getByRole('button', { name: 'New Thread' })).toBeDisabled();
  await expect(page.getByRole('dialog', { name: 'New Thread' })).toHaveCount(0);
  expect(fixture.posts).toHaveLength(0);
});

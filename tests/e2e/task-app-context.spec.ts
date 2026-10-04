import { expect, test, type Page } from '@playwright/test';

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

const json = (body: object) => ({
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
  const fixture = {
    bot: bot(options.busy),
    groups: [
      ...(options.eligible === false ? [] : [group(APP_ID, APP_NAME, [BOT_ID], { cwd: APP_FOLDER })]),
      group('group-dm', 'Private DM', [BOT_ID], { dm: true, cwd: '/fixture/dm' }),
      group('group-nonmember', 'Other Bot App', ['bot-elsewhere'], { cwd: '/fixture/other' }),
      group('group-no-folder', 'No Folder App', [BOT_ID], { pinnedCwd: '/fixture/pinned-only' }),
    ],
    posts: [] as PostBody[],
  };

  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === '/api/events') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'retry: 30000\n\ndata: {"kind":"hello","resumed":true}\n\n',
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
      fixture.bot = {
        ...fixture.bot,
        threadId: NEW_THREAD,
        tasks: [
          {
            threadId: NEW_THREAD,
            title: 'New Thread',
            createdAt: NOW + 100,
            ...(workspaceContext ? { cwd: SAVED_FOLDER, workspaceContext } : {}),
          },
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
  await page.getByRole('complementary', { name: 'Bots and Navigation' }).getByText('Atlas', { exact: true }).first().click();
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
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const narrowScreenshot = testInfo.outputPath('task-app-context-narrow.png');
  await page.screenshot({ path: narrowScreenshot, fullPage: true });
  await testInfo.attach('task-app-context-narrow', { path: narrowScreenshot, contentType: 'image/png' });
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
    (window as typeof window & { __taskMenuAction?: (action: string) => void }).__taskMenuAction =
      (action) => menuAction?.(action);
  });
}

async function triggerNativeNewThread(page: Page) {
  await page.evaluate(() => (window as typeof window & { __taskMenuAction?: (action: string) => void }).__taskMenuAction?.('new-task'));
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
  await page.keyboard.type('should not reach composer');
  await expect(composer).toHaveValue('draft stays in the old conversation');
  expect(fixture.posts).toHaveLength(0);
});

test('native New Thread is inert in Simple mode', async ({ page }) => {
  await installNativeMenuStub(page);
  const fixture = await mockServer(page, { conversationMode: 'simple' });
  await openBot(page, false);

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

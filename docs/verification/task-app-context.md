# App Task Context

Issue: [#816](https://github.com/Simple-With-Us/BotFleet/issues/816).

## Contract

`POST /api/bots/:botId/tasks` accepts an optional `appRef: { kind: "group", id }`.  The group is an explicitly selected App home; the new conversation remains a private bot task with its own `threadId`.  The server requires an existing non-DM group assigned to that bot and a configured, accessible group working folder.  Phone-originated requests also obey the existing folder confinement rules.

The server captures `task.workspaceContext`:

```ts
{
  kind: "local",
  appRef: { kind: "group", id: string },
  cwd: string,
  git?: { checkoutRoot: string, branch: string | null, headCommit: string | null },
  capturedAt: number
}
```

`cwd` is the canonical execution directory, including a selected subdirectory.  Git information describes the checkout at creation; it never replaces `cwd`, grants write ownership, checks out a branch, or proves repository identity has remained unchanged.  Unavailable Git probes omit `git`.  The client cannot supply trusted path or Git metadata through this endpoint.

The binding survives default-folder changes, renaming, persistence reloads, bot transfers, and automation rollover.  Moving a bound task into a different App's group is refused.  Merge operations require matching explicit App references and execution folders, or two unassigned tasks; a bulk Simple-mode merge preflights every task before mutating any transcript or setting.  Changing tabs, section labels, and similar paths never assigns or retargets an existing task.

Local bindings refuse cloud, Grok, and Box dispatch paths that currently discard local working directories.  The guard runs before provider ownership and again before provider invocation, including room tasks transferred from private conversations.  A missing, redirected, or inconsistent folder fails instead of falling back to the bot's default folder.  Legacy tasks without `workspaceContext` retain their existing behavior.

## Isolated Verification

```sh
pnpm exec vitest run server/task-workspace-context.test.ts server/tasks.test.ts server/group-tasks.test.ts server/task-app-context-api.test.ts
pnpm typecheck
pnpm test
```

The focused tests use temporary directories and isolated stores or a harness on a free local port.  They do not use the running app, real provider credentials, or port 8799.  Git fixtures cover a repository subdirectory separately from the checkout root; HTTP fixtures cover server-resolved creation and folder restrictions; persistence tests cover transfers, merge refusal, and rollover.

## Client Creation And Display

In Projects mode, New Thread opens an explicit App choice when that bot belongs to a non-DM group with a configured folder.  Unassigned retains the existing creation path, and bots without eligible Apps create an unassigned thread directly.  Simple mode does not open the chooser; changing to Simple dismisses an open chooser.  Busy bots cannot create another thread.

The browser sends only `appRef`, and the server returns the saved execution folder.  The active conversation displays the saved App and exact folder, including a stable reference when its App has been removed.  Default-folder changes never relabel the saved folder.  Bot/group transfers preserve the context locally, and move/merge projections wait for HTTP success so a refused operation cannot hide the original conversation.

```sh
pnpm exec vitest run src/state/store.task-app-context.test.ts src/state/store.test.ts
pnpm exec vite build
pnpm exec playwright test tests/e2e/task-app-context.spec.ts
```

The browser fixture intercepts every `/api/**` request, including a catch-all, and supplies temporary in-memory App/task records.  It covers App eligibility, canonical server snapshots, changed defaults, removed Apps, unassigned creation, busy and Simple modes, and repeated native-menu focus.  Screenshots are written to Playwright test output and retained by the hosted E2E workflow for desktop, narrow-screen, and chooser inspection.  The fixture never contacts the running harness.  Narrow checks retain a strict document-width assertion and verify header-control bounds at 320px and 390px with a busy bot and long name; header actions wrap instead of escaping the screen.  Failure artifacts retain the narrow screenshot and element geometry for diagnosis.

## Remaining Milestone Work

Future task creation from the matrix must explicitly pass `appRef`; browsing remains a read-only selection.  The creation/display slice alone does not expose a new workspace mode.  Thread attention remains keyed by `threadId`, with unread acknowledgment separate from approvals and errors.  Checkout write admission, resource isolation, and safe parallel work remain separate work before expanded fan-out.  This change creates no worktrees and enables no additional concurrency.

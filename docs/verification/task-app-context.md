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

## Remaining Milestone Work

The App picker and matrix navigation must explicitly pass `appRef`; this backend alone does not expose a new workspace mode.  Thread attention remains keyed by `threadId`, with unread acknowledgment separate from approvals and errors.  Checkout write admission, resource isolation, and safe parallel work remain separate work before expanded fan-out.  This change creates no worktrees and enables no additional concurrency.

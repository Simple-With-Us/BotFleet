# Paseo-Inspired BotFleet Adoption Review

Status: source review and implementation proposal, not a claim that these features have shipped.  CODEX, Sat, Oct 3, 2026.  Research board: `3262c05e`; BotFleet binding issue: [#816](https://github.com/Simple-With-Us/BotFleet/issues/816).

Upstream snapshot: [`getpaseo/paseo` at `749fe3e5ae52b6e1e4eaeadce3182e901caa96d9`](https://github.com/getpaseo/paseo/tree/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9).  Reviewed source and test assertions; did not install or run Paseo.  The site supplied workflow leads, not proof of implementation.  This review adapts concepts without importing source code.

## Recommendation

Keep BotFleet's recognizable bots and shared rooms.  Add a stable App home for navigation, bounded tasks for work, and an explicit workspace record for each task's execution context.  Borrow Paseo's durable workspace identity, status projections, and recovery discipline before considering its broader plugin or orchestration platform.

The central invariant is: **choosing another App changes the view; it never changes an existing task's repository, directory, or continuation.**

```text
Bot identity ── membership ── App home
                               │
                        Repository defaults
                               │
                        Task / conversation
                               │
                     Workspace binding + runs
                     host · repo · checkout root
                     exact cwd · branch · base ref
```

An App is a user-facing grouping, not necessarily a Git repository or a shared chat room.  Start with one default repository per App and optional room linkage.  Additional repositories require explicit task scope.  Each task records the repository and workspace it actually uses; later App-default changes apply to new tasks.

A bot can have several App homes without running several turns simultaneously.  The arrangement and scheduling policy remain separate.

## What The Source Supports

| Pattern | Paseo Evidence | BotFleet Adoption |
|---|---|---|
| Durable workspace identity | [Registry records](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/packages/server/src/server/workspace-registry.ts#L51-L90) separate project/workspace IDs from paths, branch, and checkout ownership. | Pin task membership and workspace explicitly; do not infer ownership from whichever App is selected or which bots belong to a room. |
| Execution directory differs from checkout root | [Placement model](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/packages/server/src/server/workspace-registry-model.ts#L59-L146) records both. | Preserve `cwd` such as `ios/` separately from the encompassing Git worktree.  Use the checkout root for write ownership and cleanup. |
| Attention differs from execution state | [Stored agent fields](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/packages/server/src/server/agent/agent-storage.ts#L45-L74) and [status classifier](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/packages/protocol/src/agent-state-bucket.ts#L22-L35) retain both. | Store durable read acknowledgment separately from runtime status, open approvals, and terminal failure. |
| Ownership-based aggregation | [Workspace directory](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/packages/server/src/server/workspace-directory.ts#L360-L403) attributes state by workspace ID. | Key task attention by `threadId`; aggregate to App and bot using persisted task membership.  Same-path tasks must not inherit each other's attention. |
| Consistent reconnect | [Hydration transaction](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/packages/app/src/runtime/directory-sync/transaction.ts#L1-L56) rejects stale connection results and buffers updates. | Send a server-authoritative snapshot and ordered updates; use revisions so an old response cannot resurrect cleared badges. |
| Scoped archive and recovery | [Archive service](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/packages/server/src/server/workspace-archive-service.ts#L350-L530) checks ownership/references; [recovery](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/packages/server/src/server/session/workspace-recovery/workspace-recovery-service.ts#L93-L180) restores recorded placement. | Archive the task separately from deleting its checkout.  Recover the expected workspace and verify the subdirectory before resuming. |
| Workspace handles across interfaces | [SDK workspace contract](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/public-docs/sdk/workspaces.md) supplies identity and directory together. | Have UI, CLI, and bot tools call the same task/workspace creation boundary instead of assembling independent path arguments. |

## Correction To The Initial Shared Study

The quoted loading test was interpreted backwards in the initial peer packet.  [Its assertions](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/packages/server/src/server/agent/agent-loading.test.ts#L128-L136) require attention and timestamps to survive runtime loading.  Loading a session is neither new work nor reading it.

Paseo can acknowledge non-permission attention when viewed, but [workspace clearing](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/packages/server/src/server/session.ts#L7422-L7455) excludes pending permissions and preserves execution status.  An error status still classifies as Failed.  **Acknowledging a notification does not resolve an execution failure or approval.**

Paseo's Done bucket is residual idle/read state.  It is not proof that code passed tests, was reviewed, merged, or deployed.  In BotFleet use an honest idle state, with independent delivery evidence where known.  Likewise, Ready To Review should require an actual reviewable artifact if that is what the label promises; otherwise use New Reply.

Five exclusive display buckets are also not equivalent to exact numerical counts across five independent dimensions.  BotFleet's App badges should retain explicit units: distinct bots with unread replies, pending approval requests, and failed tasks needing action.  A task can be running while it has an unread reply, so a highest-priority display bucket must not discard the underlying facts.

## Implementable Sequence

1. **Task Binding, CODEX — current lane.**  Pin explicit repository selection when creating a task, retain both checkout root and execution cwd, and expose the context near the task title.  Introduce one service/API boundary for resolution and validation.  App selection never calls a path mutation.  The existing small patch snapshots an explicit bot cwd before the first turn; it does not yet implement App identity or all default/cloud cases.
2. **Thread Attention, MiniMax — server lane.**  Introduce a projection keyed by thread ID, durable read acknowledgment, approval IDs, and an explicit terminal outcome.  Derive current work from authoritative turn ownership.  Hydrate on boot and reconnect.  This can ship under today's serial-per-bot gate; workspace leases are not a dependency of status derivation.
3. **App Matrix And Triage, Antigravity — client lane.**  Use the shared settings resolver.  App tabs filter bot/task views and show separate typed badges.  Add a Needs You list with exact-task links and keyboard navigation.  Sort with explicit policy: blocking decisions first, then age where useful; a timestamp alone does not establish an oldest-first queue.  An axes-swap option should change layout only.
4. **Workspace Ownership — designated VACUUM lane, acknowledgment still needed.**  Admission must consider the actual checkout resource, not only `(botId, appId)`.  Separate tasks can otherwise acquire different logical keys for the same files.  Canonicalize local path aliases and include host identity; distinguish read sharing from write ownership.  Preserve serial bot execution until multi-turn ownership, stop/steer, approvals, and crash recovery are ready.
5. **Delivery Evidence And Recovery.**  Attach PR/check results to exact commits and show freshness.  Add safe archive/recovery and explicit workspace setup/service controls.  A passing check on an old commit must not imply the current workspace is verified.
6. **Bounded Parallel Execution, Later.**  Permit additional task runs only with supported provider state, workspace/resource admission, budget limits, and explicit ownership.  New sessions do not create new subscription quota.

Slices 1 and 2 can advance independently on their own authoritative IDs.  App-wide aggregation waits for task membership; write admission waits for checkout ownership.  This avoids making every lane wait for a single concurrent-lease implementation.

## Acceptance Fixtures

- Creating a task in repository A, then selecting App B or changing a bot default, preserves the task's A binding and provider continuation.
- An unset folder, an explicit default/home choice, a managed private workspace, and a cloud execution target remain distinguishable.  No `null` fallback change may accidentally suppress workspace allocation.
- Two tasks sharing one directory keep separate read state; two path aliases to one writable checkout do not bypass ownership.
- An unread response survives restart/reconnect.  Reading it does not clear an approval or resolve a failed run.  A stale snapshot cannot revive acknowledged attention.
- Archiving one task preserves a referenced/shared checkout.  A missing subdirectory during restore produces a repairable state rather than silently running at a different root.
- A group room's actual approval requester remains attributable even when it differs from the visible speaker.

## Ideas To Defer Or Adapt Carefully

- **CLI wrappers:** already central to BotFleet.  Audit concrete missing provider capabilities instead of building another wrapper engine.
- **Plugins:** Paseo explicitly documents [trusted, unsandboxed code](https://github.com/getpaseo/paseo/blob/749fe3e5ae52b6e1e4eaeadce3182e901caa96d9/public-docs/plugins/index.md).  Start with internal extension interfaces or a concrete provider gap; a public plugin ecosystem adds cross-client compatibility, credentials, updates, and trust decisions.
- **Ephemeral helpers:** a useful comparison, but BotFleet already has a landed jobs/helpers decision using native helpers and `delegate_bot`.  A new BotFleet helper runtime would revise that decision and needs a separate design case.
- **Remote relay and voice:** worth independent reviews where a current connectivity or hands-free workflow is painful.  They are not prerequisites for fixing repo continuity or App navigation.
- **Git watchers:** observing Git metadata helps freshness; it cannot by itself prevent a different process from resetting an integration checkout.  Keep isolated lanes and explicit ownership.
- **Worktrees:** isolate files, not databases, browser sessions, ports, credentials, or deployments.  Paseo's workspace port allocation is a useful later pattern, not proof of complete environment isolation.

## Additional BotFleet Opportunities

These are proposals, not claims of global novelty:

- **Decision Queue:** each approval explains the exact task, requested action, and work it blocks; completing one decision advances to the next without losing the App context.
- **Evidence Receipt:** every task can present a compact result with commit, checks, reviewer, artifact, and unresolved concerns.  Completion depends on evidence rather than an idle bot.
- **Workspace Passport:** one inspectable context panel records host, repository, checkout, exact cwd, base commit, and owned services.  The same record travels with handoffs and resume requests.
- **Continuity Handoff:** switch the model or reviewing bot while preserving the task workspace and a bounded handoff summary; provider-specific continuation IDs remain separate.  Reusing a task context does not mean pretending two providers share one native session.
- **Conflict Preview:** before a second writing task starts, explain overlap with active work and offer a fresh worktree or a queued start.  Read-only review may share a checkout; writing needs explicit admission.

## Coordination And Evidence Limits

AG and MiniMax published initial studies; Grok challenged duplication of existing drivers; CODEX and Astra checked attention semantics and workspace ownership against the pinned source.  Recommendations above include CODEX proposals still awaiting peer agreement.  VACUUM has not acknowledged the lease seam in the messages reviewed.  Do not treat dispatched requests as completed reviews or silence as agreement.

The source review is complete for the patterns cited here; runtime usability, performance, relay security, and cross-device behavior were not tested.  BotFleet's existing folder-snapshot regression passed 87 focused tests before this review; full project validation and delivery are tracked separately in #816.  The larger #816 App/repository binding work remains open.

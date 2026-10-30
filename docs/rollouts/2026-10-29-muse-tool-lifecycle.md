# Muse Lifecycle And Capacity Recovery

Refs BF-2589.

Muse's ACP adapter exposes hooks, reminder children, workflows and subagents as public tool items.  Different items can share a title such as `hookRun: inProgress`, and a tool can arrive with its final status and output on the initial notification.  The harness previously counted those status-only titles as repeated calls, ignored initial terminal statuses and retained the initial title after completion.

The ACP driver now completes initially terminal tools immediately, records their result and keeps them out of its open-call set.  A title supplied with a terminal update reaches the transcript row.  The repeat detector ignores the known status-only lifecycle titles in its title fallback while continuing to count actual tool arguments and commands.

The shared role prompt also explains the existing separation between BotFleet identities and registered lane seats.  A refused role preserves its identity, uses an existing assigned repository workspace when available, or hands off the exact blocker to a registered coding seat.  Repository and temporary-directory guards remain enforced.

Scheduled and webhook work with a saved fallback chain now stays queued while its primary is cooling down and no saved fallback is available.  Normal scheduler ticks retry the receipt when a route recovers.  A running turn also skips already cooling fallback routes.  Box-backed cloud work retains its separate execution gate, and bots with no saved chain retain automatic engine selection.

Concurrency, in-flight session limits and ambiguous rate-limit refusals use a separate, short-lived capacity hold.  The default retry is five seconds; an explicit retry delay is respected up to five minutes.  Recent successful activity from another active bot on the same provider instance and exact model can prevent that hold, and subsequent healthy output, a successful real tool or a successful turn clears it.  A different model or connection does not count as evidence for that route.  Stream prefixes are accumulated before counting activity so fragmented error messages do not look like successful output.  Helper activity, generic lifecycle items and synthetic notices do not establish the parent model's health.

Explicit plan, usage, spend, credit and billing exhaustion retain quota handling and reset times.  Healthy sibling activity clears only transient capacity holds; it does not erase a hard quota hold.  Existing provider-error cooldowns created from transient refusals are discarded when their saved reset was the synthetic default rather than an explicit provider reset.

Status reporting does not cap a Muse workflow or prove that a long turn has finished.  The generic lifecycle labels alone do not identify repeated commands, so actual argument-based repeat detection remains enabled.  This change does not substitute another provider's model for a saved selection.

## Verification

Synthetic ACP fixtures exercise initial success and failure notifications with output, and a running tool whose terminal update supplies a refreshed title.  Transcript-fold and event-reader tests cover the optional terminal title.  Repeat-detector tests distinguish generic lifecycle statuses from real commands and arguments.

Run from the task lane:

```sh
pnpm exec vitest run server/drivers/acp/acp.test.ts server/thread-events.test.ts server/tool-row.test.ts shared/clip-runtime-event.test.ts server/repeat-detector.test.ts server/seat-prompt.test.ts server/model-fallback.test.ts server/provider-route-activity.test.ts
pnpm exec vitest run server/index.test.ts -t 'capacity-held|cooling|still falls over from a successful-looking standalone quota chip'
pnpm typecheck
pnpm lint
pnpm test
git diff --check
```

These fixtures do not contact the live harness or run real bot turns.  Deployment requires updating the Node harness used by the installed Electron app; a native Mac build does not exercise this path.  Existing historical warning rows are retained.

The full local test gate was attempted: 12,166 tests passed, 38 failed and 26 were skipped.  Failures were confined to six untouched suites covering environment-specific CLI discovery, credential subprocess stdin, plugin sandbox exits and recall deadlines.  The targeted recall suite passed independently; the plugin sandbox failure also reproduces independently and its cause remains unverified.  Hosted full checks remain required before merge.  The owner requested that BotFleet remain closed, so installation and live bot-turn verification are pending.

# Graceful Stop: Stop The Bots, Then Shut The Server Down

BF-2536 implements the owner's request on the Linear row: "Stop active bots gracefully, then shut the server down."  The owner's own words are in Jet's Oct 21 relay (Zulip 633678612):  "yes and also, it could just stop the bot", "It warns you before how many are running", and "and regardless you should know if stopping it".

## What Changed

Two stop paths existed and neither did that.  `POST /api/system/control/stop` refused with 409 while work was in flight, so BotFleet Control reported the refusal and left everything running.  `POST /api/system/shutdown` wrote the deliberate-stop marker and exited 250 ms later with no fence, so a turn in flight was cut in half.  Both now run the same sequence, which lives in `server/graceful-shutdown.ts` with its dependencies injected, the way `reserveSystemShutdown` takes them, so the whole thing can be exercised without a running server.

The sequence is four steps.

1. **Fence.**  Admission closes before anything else, so no new turn starts while the stop runs.
2. **Wait.**  The work in flight gets a bounded window to settle on its own.  A turn that ends inside the window is finished work.
3. **Park.**  The messages queued behind the bots that are being stopped are carried across the restart by the same carrier the update drain parks work in (`persistHeldWork`).  The bots that are being stopped keep their queued sends uncommitted, because their own turn resumes first at the next boot and boot recovery reads the thread to find it.
4. **Exit through the signal handler.**  The server now exits with `process.kill(process.pid, "SIGTERM")` instead of `process.exit(0)`, so the harness's own shutdown runs:  it interrupts the turns that are still going, records them for the next boot, flushes the event log and the stores, and gives the children their interrupt.  `process.exit` skipped all of that, and that is what cut a turn in half.

The graceful stop does not interrupt anything itself.  `interruptBot` carries the Stop button's meaning:  it cancels the bot's routine runs and snoozes its automation, which is right for a person pressing Stop and wrong for a server going down.  The harness's shutdown already knows how to end a turn without losing it, and it is the one place that does.

## What The Stop Still Refuses

The refusal stands for the work a graceful stop cannot carry across the restart, and the server says why in the owner's words rather than counting at it.

Carried or ended cleanly:  a bot turn (interrupted and recorded for the next boot), a completion fold (the tail of a turn whose events are already in the event log), a delegated task (held by the job registry, which is on disk), a connector or a secret resume (a card in the thread's transcript), and a routine run (held by the routines store).

Refused:  a room turn, an in-flight request, a provider reload, a file restore, a VPS thread or mode change, a Local VM task or change, and the server still starting.  A room turn is the one that matters:  the harness's shutdown deliberately skips a room turn, because a room turn cannot be resumed without repeating it, so stopping would lose the work rather than carry it.  The refusal says so:  "a room turn is in flight, and a room turn cannot be resumed without repeating it, so the server stays up."  Every other refusal keeps the count-and-kinds wording the owner already knows, because there the answer is to wait for the work.

The work that is held rather than in flight (a queued message, a queued room round, a queued routine run) is not a reason to refuse:  it is what the stop parks.

`reserveSystemShutdown` keeps its shape and its tests.  Its count is a refusal whenever the caller cannot say what would happen to the work, which is still the safe default.  `canStopGracefully` is what says the work in flight is work the graceful stop settles, and a new optional `refusal` callback lets a caller that knows more than a count word the refusal itself.

## The Report

`POST /api/system/control/stop` answers 200 with the report beside its existing payload.  The report names the bots that had already finished, the bots that were still working and that the shutdown stops, and what was still running when the window closed.  BotFleet Control shows the summary in an alert after the stop, and its confirmation no longer promises a refusal the server will not make.

An older server sends no report, and Control is told nothing rather than something invented.  `ControlAPI.stopServer()` returns `ControlStopReport?`, so the absence of a report is a normal answer and not a failure.

## The Window

The graceful stop waits 10 seconds for the work in flight to settle, and the wait ends early as soon as the work settles, so a quiet server stops without waiting at all.  The window is a bound and not a promise:  when it passes, the server shuts down anyway and the report names what did not finish.

The size comes from the clients rather than from the drain:  the native Mac app waits 30 seconds for this route, and a Local VM container stop in the same request can take 10 of them, so the window takes 10 and leaves the rest to the container.  The worst case for the answer is therefore the window plus that container stop plus the harness's own 3-second shutdown grace, and it fits inside the native app's budget.  BotFleet Control waits 300 seconds for the stop, so it is not the constraint.

## Verification

The affected fixtures are `server/graceful-shutdown.test.ts` (14 tests), `server/system-control.test.ts` (18 tests) and `server/desktop-open-policy.test.ts` (8 tests), 40 in total, and they pass.  The integration suite `server/index.test.ts` passes 312 of 312 on its own, including the one that asserts the stop route refuses an in-flight request and writes no marker.

```sh
pnpm typecheck
node scripts/check-lint-baseline.mjs
pnpm exec vitest run server/graceful-shutdown.test.ts server/system-control.test.ts server/desktop-open-policy.test.ts
pnpm exec vitest run server/index.test.ts
pnpm test
```

The graceful stop's fixture injects the clock, the wait, the bot roster, the in-flight count and the work breakdown, so the window, the classification of a finished bot against an interrupted one, the refusal when the queued work cannot be saved, the refusal wording and the report's wording are all exercised without a server, a store or a filesystem.

The local full `pnpm test` run counted 12,491 tests:  12,460 passed, 6 failed and 25 skipped.  The six failures are in two files this change does not touch.  `server/env-path.test.ts` fails four times because a real `/usr/local/bin/dsh` exists on this host, and the same four failures reproduce on `origin/main`.  `server/index.test.ts` fails two webhook tests when the whole suite runs at once, because the webhook receiver binds one fixed port and the suite runs hundreds of files in parallel;  both pass when that file runs on its own.

The lint baseline is unchanged at 4,867 warnings.  The hosted required gate is the merge authority.

## Limits

The Swift changes cannot be unit-tested on this build host, because it has no Swift toolchain.  The hosted gate is not the same as a test run for the Control app either:  `mac-package-gate` builds it, so the Swift half is compile-checked there, and `ci.yml` runs `swift test --package-path ios`, which covers the companion changes, but no workflow runs `swift test --package-path mac-control`.  The two new Control tests are therefore written and committed but unrun.

`docs/plans/2026-10-29-botfleet-control-after-node.md` still describes the old behavior in its inventory of the two stop paths.  It is a snapshot from its authoring date and is left as it is; this note is the current statement of the contract.

The touched sources keep the two-space sentence gap their files already use.  The newest documents in this repository use a no-break space instead, and a future sweep should settle the repository on one form.

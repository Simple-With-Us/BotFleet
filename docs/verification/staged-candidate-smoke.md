# Staged Candidate Smoke Test

The pre-activation probe that runs a Mac update candidate before anything live
is touched.  Part of the [Mac updater transaction](mac-updater.md).

## What It Proves

`validateBuiltBundle` reads files.  It proves the bundle is signed by the
expected team, carries the expected bundle identifier, and is stamped with the
expected commit.  None of that proves the artifact **runs**.

0.1.24 shipped a server that passed every one of those checks and died on every
launch with `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'`, because `tsc`
leaves bare imports verbatim and the packaged tree carries no `node_modules`.
The hosted release pipeline has caught that class of bug since
(`scripts/smoke-packaged-server.mjs`) — but only for artifacts GitHub built.  A
candidate that was downloaded from a CI build, imported from an existing stage,
or produced by a local fallback had no equivalent gate on the Mac that installs
it.

So the probe runs the candidate, before the stage is published and before any
`launchctl`, `/Applications`, or `node_modules` change.  Three properties, and
no more, because each one must survive a saturated host without producing a
false verdict:

| Property | How | Failure cause |
|---|---|---|
| It boots with no `node_modules` in reach | Copies `Contents/Resources/server` out of the bundle and runs it on the **packaged Electron binary** with a reserved loopback port and a throwaway `HOME` | `server-exited`, `server-never-ready` |
| It finishes booting, not just binds a port | Waits for `/api/health` and requires a **validated** body (a boolean `ready` and a string `app`), then requires `~/.botfleet/harness-owner.json` to name the probe's own pid | `server-never-ready` |
| Its native SQLite binding loads | Opens and round-trips a row through `DatabaseSync` from `node:sqlite` on `:memory:` | `sqlite-unavailable`, `sqlite-probe-timed-out` |

The probe runs the candidate on the runtime that will actually serve it: the
packaged Electron binary under `ELECTRON_RUN_AS_NODE=1`, which is exactly how the
harness launches it (`server/index.ts`'s `AGENTS_NODE_FLAG`) and why
`electron-builder.yml` keeps the `runAsNode` fuse on.  Testing with the updater's
own Node would answer a question nobody asked — the Homebrew or nvm Node could
have `node:sqlite` while Electron's bundled Node does not, or the reverse, so the
probe could fail a healthy build or pass a broken one.

The store opens its database through `node:sqlite` (`server/message-db.ts`), a
native binding that must load before the harness can run at all — the same
reason MCode initializes `better-sqlite3` in memory before trusting a
downloaded release.  The probe uses `:memory:` on purpose: a lazily created
`messages.db` is not a broken one, and this gate must never fail a healthy
build for being lazy.

## Why A Timeout Is Not A Broken Build

The Sep 17 and Oct 1 update outages were both *a healthy binary plus a starved
CPU* — host load 400–700 while five to ten agent seats compiled.  Every timeout
tolerance widened so far was inside a step that should not have been running on
that machine at all.

`classifySmokeFailure` therefore keeps the two apart, and
`runStagedSmokeTest` retries **only** a readiness timeout:

- readiness timeout → retried once (180s per attempt); if it times out again
  the message says the Mac may have been too busy and explicitly tells the
  operator to re-run before treating the build as bad;
- process exit, missing SQLite binding, or a spawn failure → **never** retried.
  Waiting cannot change the answer, and retrying would only delay the real
  diagnosis.

## Isolation

The probe never touches live state:

- a fresh `HOME` under the system temp dir, so no real config, credential, or
  `harness-owner.json` is read or overwritten;
- a port reserved by the OS on `127.0.0.1:0`, asserted not to be one of
  `DEFAULT_PORTS`, so it can never collide with the running harness;
- no Sentry configuration at all: the child environment is built from scratch
  rather than inherited, so omitting the variable is what guarantees the probe
  cannot reach a real project;
- scratch under the system temp dir, deliberately **not** under
  `BOTFLEET_UPDATE_ROOT`, whose entries are scanned for abandoned stages and
  rollback generations.

## Recipe

```sh
# Coordinator ordering: the probe runs after validation, before publishing.
node --test scripts/mac-update-transaction.node-test.mjs

# Classifier, message shape, bypass switch, and the retry policy.
node --test scripts/update-botfleet-mac.node-test.mjs

# The probe itself, against a real signed bundle on this Mac.  This is the only
# way to prove the probe works rather than that its classifier does.
node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { smokeStagedServer } from "./scripts/update-botfleet-mac.mjs";
const bundle = "/Applications/BotFleet.app";
const { sourceCommit } = JSON.parse(
  await readFile(join(bundle, "Contents/Resources/server/build-identity.json"), "utf8"));
const result = await smokeStagedServer({
  bundlePath: bundle, targetCommit: sourceCommit, attempt: 1,
  scratchRoot: join(tmpdir(), "botfleet-update-smoke"),
});
console.log({ commit: sourceCommit.slice(0, 12), ready: result.ready, sqliteOk: result.sqlite?.ok });
if (!result.ready || !result.sqlite?.ok) process.exit(1);
'
```

Observed on this Mac, 2026-10-04, against the installed `d9e646ffc292` bundle:
`ready: true`, `sqliteOk: true`, 17.6s on a quiet machine and 51.4s while four
other seats were compiling — which is the reason the boot budget is 180s rather
than something tighter.  The live harness stayed `ready: true` throughout, with
no scratch left behind and no stray processes.  The port the harness itself
listens on is a private operations detail, kept in the fleet's local-process
record rather than in a public verification doc; the recipe above reserves its
own port instead of naming one.

## Bypass

`BOTFLEET_UPDATE_SMOKE=0` (or `off`/`false`/`no`) skips the probe.  It exists for
a genuinely offline fallback, and it says so out loud — the candidate is
unproven, and the updater says that rather than pretending the gate passed.

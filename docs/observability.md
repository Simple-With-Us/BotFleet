# Observability (Sentry)

BotFleet reports crashes, errors, and a sample of performance traces to
Sentry (`jays-services/botfleet`) from five surfaces: the Mac harness, the
Electron desktop renderer, the iOS TestFlight app, the public desktop
releases (macOS/Windows/Ubuntu installers built by CI), and a local desktop
package built by hand on the owner's Mac.  Every surface is off unless a DSN
reaches it — there is no shipped default, and none has ever been in source.

## Where the DSN lives

- **Infisical prod (canonical).**  `SENTRY_DSN` and `VITE_SENTRY_DSN` live in
  the BotFleet project, `env=prod`, `path=/`.  These two names are the source
  of truth; every CI workflow resolves from here first.
- **GitHub Actions secret (synced copy).**  `SENTRY_DSN` on
  `jaywedgeworth22/BotFleet` is a fallback for when a workflow's Infisical
  login fails (CLI install hiccup, a rotated machine identity, and so on).
  It is read only from step `env:`, never from an `if:` condition — GitHub's
  dispatch parser rejects `secrets.*` inside `if:` with an HTTP 422 (the same
  failure class as DealDex #175 and Usage-Monitor #1343).
- **`~/.botfleet/config.json`** `observability.sentryDsn` is where the Mac
  harness gets its DSN.  Set it from Settings → Observability in the app, or
  with one loopback `PATCH /api/config` (see below) — never by hand-editing
  the file while the harness is running.
- **Never in source.**  PR #108 removed a hardcoded DSN from the iOS app; only
  environment variable names and config keys appear in this repository.  A
  `grep -r` for `ingest.sentry.io` in tracked files should turn up nothing but
  this document and code comments referencing the name.

## Precedence and the kill switch

The Mac harness resolves, in order:

1. `process.env.SENTRY_DSN` or `process.env.BOTFLEET_SENTRY_DSN` — source
   `env`.  An operator (CI, a LaunchAgent `EnvironmentVariables` block) can
   pin a value this way; Settings shows the DSN field disabled with "Set by
   the environment on this computer" and the source reads "Environment".
2. `~/.botfleet/config.json` `observability.sentryDsn` — source `config`.
   This is the normal path: set it once from Settings → Observability.
3. Nothing configured — source `none`.  The boot log prints
   `[sentry] disabled: no DSN configured (set one in Settings > Observability)`
   and nothing is sent.

The kill switch is explicit, not implicit.  A DSN being present is not enough
to silently start reporting forever, and it is not enough to silently stop
either:

- `observability.enabled` **absent** → Sentry runs (opt-out, matching
  `ingress.enabled`).
- `observability.enabled: false` → Sentry stops immediately, no restart
  needed.  The boot line and the `GET /api/observability` status both say so.
- `observability.tracesSampleRate: 0` stops performance traces only, and is
  reported as `traces=0` in the boot line — not silently defaulted back to
  the normal sampling rate.

Changing any of these through `PATCH /api/config` takes effect live: the
harness tears down the running Sentry client (`Sentry.close()`, fire-and-
forget, never blocking the request) and re-initializes against the new
settings in the same process.

## Settings → Observability

The desktop app's Settings has an **Observability** section ("Diagnostics &
Error Reporting") next to Usage Monitor.  It shows a status pill (host only,
never the full DSN), the environment, the source ("Settings" / "Environment"
/ "None"), the traces sample rate, and whether warnings/errors are forwarded
as Sentry Logs.  **Save** stores the DSN on this computer and applies it
immediately; **Send Test Event** creates one real event in the Sentry project
so you can confirm delivery.  Leaving the DSN field blank on Save keeps the
value already stored — there is no accidental-wipe path.  Clearing the DSN
is a separate, explicit "Remove Diagnostics Key" action.

Prompts, transcripts, and tool arguments are never sent to Sentry from any
surface.

## The two HTTP routes

Both live in the same loopback-only block as `/api/telemetry/*` — no extra
auth beyond the existing loopback gate and origin check.

```
GET /api/observability
```

```json
{
  "enabled": true,
  "configured": true,
  "source": "config",
  "host": "o123.ingest.sentry.io",
  "projectId": "456",
  "environment": "production",
  "tracesSampleRate": 0.2,
  "logsEnabled": true,
  "profilingAvailable": false,
  "totalCaptured": 12,
  "lastEventAt": "2026-09-08T12:00:00.000Z",
  "lastError": null,
  "dsn": "https://abc123@o123.ingest.sentry.io/456"
}
```

The full DSN is included here on purpose: the desktop renderer cannot start
the browser SDK without it, and the same value already ships publicly in
botfleet.app's built HTML.  `GET /api/config`, by contrast, only ever adds
`hasDsn` and `host` under its `observability` block — never the DSN itself —
because that frame is broadcast to every open window and, with Remote Access
on, over the tunnel.

```
POST /api/observability/test
```

```json
{ "ok": true, "error": null, "eventId": "9f1c2b3a4d5e6f708192a3b4c5d6e7f8" }
```

On an unconfigured install this returns `{ "ok": false, "error": "Set a
Sentry DSN first.", "eventId": null }` without touching the SDK.

```
PATCH /api/config
```

```json
{ "observability": { "sentryDsn": "https://abc123@o123.ingest.sentry.io/456", "enabled": true, "environment": "production", "tracesSampleRate": 0.2, "logsEnabled": true } }
```

Every field is optional and merges into the stored config; an empty string
for `sentryDsn` clears it (the only way to clear it over the API — omitting
the field leaves the stored value untouched).

## How each surface gets its DSN

1. **Mac harness** (`com.jay.botfleet-server`).  Resolution order above.
   Boot line on success:
   `[sentry] enabled (config) env=production traces=0.2 logs=on host=o123.ingest.sentry.io project=456`.
   The DSN's key and the full DSN string never reach a log line, an error
   message, or a broadcast frame.
2. **Desktop renderer** (`/Applications/BotFleet.app`).  Two paths, either
   sufficient on its own: a build-time `VITE_SENTRY_DSN` inlined by Vite (see
   "public desktop releases" and "local packaging" below), or a runtime
   fallback that fetches `GET /api/observability` from the attached harness
   over the same `api()` helper the Settings UI uses, and initializes Sentry
   from the response when the harness reports one configured and enabled.
   The runtime path stays in step with Settings: the Observability card
   calls `refreshSentryFromRuntime()` after a successful Save and after
   Remove Diagnostics Key, which closes the renderer's client and starts a
   new one when the DSN, environment, or trace rate changed, closes it and
   starts nothing when diagnostics are turned off or the key is removed, and
   does nothing at all when the answer is unchanged.  A build-time
   `VITE_SENTRY_DSN` wins and is never re-configured at runtime — a shipped
   release reports to the DSN it was built with for the life of the window,
   and Settings governs the harness rather than that client.
3. **iOS TestFlight.**  `.github/workflows/ios-ship.yml`'s "Load Infisical
   signing secrets" step also resolves `SENTRY_DSN`: Infisical prod first,
   then the GitHub Actions secret (`GH_FALLBACK_SENTRY_DSN`, read from step
   `env:`, never from `if:`).  Empty after both prints
   `::warning::SENTRY_DSN is empty after the Infisical prod export and the
   GitHub secret fallback.  This TestFlight build ships with Sentry Cocoa
   inert.` and the ship continues — a missing DSN never fails a TestFlight
   upload.  `scripts/ios-fleet/ship-testflight.sh` logs the same condition
   locally and, under `GITHUB_ACTIONS`, emits its own `::warning::` too.
4. **Public desktop releases** (`release.yml`'s `mac` / `windows` / `linux`
   jobs, plus the standalone `package-win.yml` and `package-linux.yml`
   workflows).  Each package job runs a "Resolve the Sentry DSN" step before
   its `pnpm package:*` step: Infisical prod for both `SENTRY_DSN` and
   `VITE_SENTRY_DSN`, the GitHub secret as `SENTRY_DSN`'s fallback, and
   `VITE_SENTRY_DSN` copied from whichever `SENTRY_DSN` resolved to when
   Infisical has no `VITE_SENTRY_DSN` entry of its own.  Both are masked and
   written to `GITHUB_ENV`, which puts them in the environment of the later
   `pnpm package:*` step on the CI runner.

   That lights up the **renderer only**.  Vite inlines `VITE_SENTRY_DSN` into
   the bundle at build time, so a public release ships with the browser SDK
   already pointed at the project.  The **harness gets nothing baked in**:
   `server/sentry.ts` reads `process.env.SENTRY_DSN` at run time, inside the
   forked `server/index.js` child process on the end user's machine, whose
   environment comes from whatever the OS hands the installed app — not from
   a `GITHUB_ENV` write on a build machine.  Nothing in `package.json`'s
   `package:*` scripts, in electron-builder, or in `electron/main.mjs` copies
   a non-`VITE_`-prefixed variable into the installed app.  On a fresh
   install `SENTRY_DSN` is simply absent, and the harness reports
   `source: none` until somebody sets a DSN in Settings > Observability (the
   `config` tier) or in that machine's own environment — the same as any
   other install.  A total resolution failure warns and continues — it never
   fails the build.
5. **Local desktop packaging.**  `scripts/with-sentry-dsn.sh` wraps a local
   `pnpm package:mac:local` (or any other `package:*` script) with the same
   three-tier resolution — already-exported environment, Infisical (only if
   already logged in; this script never calls `infisical login`), then the
   handoff file `~/.secrets/botfleet-sentry.env` via
   an `awk` read that produces only the value after the first `NAME=`, never
   the whole `NAME=value` row — and exports both `SENTRY_DSN` and
   `VITE_SENTRY_DSN` before executing the wrapped command.  It turns xtrace
   off before it reads anything, so neither `bash -x` nor an inherited
   `SHELLOPTS` can echo a resolved value, and it never prints one in any
   branch.  Usage:

   ```bash
   scripts/with-sentry-dsn.sh pnpm package:mac:local
   ```

## Product analytics (PostHog) — desktop only

This is a separate product from the Sentry reporting above: the desktop app
(Electron renderer, `src/lib/analytics.ts`) bundles PostHog and initializes
it unconditionally on mount (`src/App.tsx`), **on by default**.  It sends a
write-only client token (`phc_…`, safe to ship — it cannot read data back)
to `us.i.posthog.com` with autocapture and pageview capture both off, and
captures only two named events today: `app_first_open` (once, on first
launch) and `app_opened` (every launch), plus a `platform` property and the
identity created by an email-gate submission.  It never captures clicked-
element text, message content, or transcripts.  An install can opt out at
**Settings → General**, which calls `posthog.opt_out_capturing()` and drops
anything already queued; the choice persists in `localStorage` and is
checked before `posthog.init()` ever runs, so an opted-out install makes no
request to PostHog at all, not even to load the library.  The iOS app is a
different product with no analytics SDK at all — see
[iOS privacy](ios-privacy.md).

## What is intentionally out of scope

- A second Sentry project — everything lands in `jays-services/botfleet`.
- `@sentry/profiling-node` — not installed; `profilingAvailable` reports
  `false` and the harness warns once rather than silently no-oping.
- `ios/App/SentryTelemetry.swift` and `ios/project.yml` already handle an
  empty DSN and are unchanged by any of this.

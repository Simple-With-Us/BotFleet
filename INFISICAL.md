# INFISICAL.md — BotFleet

Owner directive (2026-10-03): Infisical is the sole source of truth for every app — secrets, env variables, and tunable settings knobs.  "Truth" means everything an app's behavior depends on that is not code.  Per-user settings stay in the app's own store and never go in Infisical.

BotFleet's Infisical project: **BotFleet** (`836aebe2-c8f7-4e09-978e-7e3e82500bce`), environments `dev` / `staging` / `prod`.  The harness reads the `prod` environment by default (`DEFAULT_INFISICAL_ENVIRONMENT` in `server/config.ts`).

## The policy

- Infisical holds secrets (provider API keys, tokens, webhook signing secrets), env config (service URLs, collections, integration endpoints), and tunable settings knobs (job limits, admission thresholds, Sentry sample rates, the spend ceiling, the Infisical refresh cadence itself).
- Per-user settings live in BotFleet's own store (the bot/room/thread database) and are **explicitly out of scope** — they never go in Infisical.  See "What stays out" below.
- Local dev overrides are documented in `.env.example`; real values are never committed.
- Secret values never appear in code, logs, PR bodies, or chat — names and metadata only.

## The runtime contract

1. **Load at startup.**  `server/index.ts` calls `infisical.preload()` (bounded by a boot cap so a slow or unreachable store can never hang boot), then re-reads the whole config with `loadConfig()`.  `loadConfig()` applies the vault snapshot last: `resolveSecretFields` (credentials, `server/secret-map.ts`) then `resolveKnobFields` (tunables, `server/knob-map.ts`).  For a name the vault holds, the vault wins over env and file.
2. **Never fetch per-request.**  `settings.get`-style reads do not exist here as network calls at all: runtime code reads the resolved `cfg` object from memory (`server/jobs/registry.ts` re-resolves job settings from `cfg.jobs` at each use; `observabilitySettings(cfg)` reads `cfg.observability`).  A per-request, per-tick or per-event call to Infisical is the one forbidden pattern.
3. **Background refresh.**  The `InfisicalManager` (`server/infisical.ts`) re-lists the vault on an interval (default 15 minutes, tunable via the `BOTFLEET_INFISICAL_REFRESH_MINUTES` knob — the cadence is itself stored in Infisical) and on demand (`Sync Now` in Settings > Secrets, any Settings save that touches the `infisical` section, `SIGHUP` where the server installs one).  Refresh failures log loudly, mark the status stale, and keep serving the last-known-good snapshot — settings staleness is safer than an outage.  An unparsable knob value is logged and ignored; the configured value stands.
4. **Write-through on admin save.**  `PUT /api/config` writes vault-managed values to Infisical FIRST (`infisical.writeSecret`, which upserts), then drops the local copy from the patch bound for disk — an empty-string tombstone for credentials, a deleted key for knobs — so the file never shadows the store.  If the Infisical write fails, the save fails (409 for a policy refusal, 502 for the store failing to answer, 503 when the store is unreachable and cannot say what it manages) and nothing is written locally.  The cache and Infisical never diverge silently.

## Admin gating

BotFleet is a single-user local harness: the server binds loopback-only (`127.0.0.1`) behind a loopback-host + origin + `sec-fetch-site` fence, and the local operator's own app (Electron) and CLIs are the only callers.  The local user IS the admin — there is no multi-user role model to gate against, and no parallel auth system was invented.  The Settings UI (including Settings > Secrets) and `PUT /api/config` are reachable only through that loopback fence, which is the documented gate.

## Key inventory for THIS app

### Credentials and env config (`server/secret-map.ts`)

| Infisical name | Config field | Kind |
|---|---|---|
| `XAI_API_KEY` | xai.key | secret |
| `OPENAI_COMPAT_API_KEY` | openaiCompat.key | secret |
| `OPENAI_COMPAT_URL` | openaiCompat.url | config |
| `MINIMAX_API_KEY` | minimax.key | secret |
| `MINIMAX_BASE_URL` | minimax.url | config |
| `COMPOSIO_API_KEY` | composio.apiKey | secret |
| `BOX_TOKEN` | box.token | secret |
| `OPENCODE_API_KEY` | opencodeGo.apiKey | secret |
| `OMB_TTS_KEY` | tts.key | secret |
| `OMB_OPENAI_IMAGE_KEY` | imageGen.key | secret |
| `DEEPSEEK_API_KEY` | deepseek.key | secret |
| `DEEPSEEK_URL` | deepseek.url | config |
| `USAGE_MONITOR_INGEST_URL` | usage.ingestUrl | config |
| `USAGE_MONITOR_INGEST_TOKEN` | usage.ingestToken | secret |
| `USAGE_READ_TOKEN` | usage.readToken | secret |
| `OMB_RECALL_URL` | qdrant.url | config |
| `OMB_RECALL_API_KEY` | qdrant.apiKey | secret |
| `OMB_RECALL_COLLECTION` | qdrant.collection | config |
| `OMB_RECALL_ACCESS_CLIENT_ID` | qdrant.accessClientId | config |
| `OMB_RECALL_ACCESS_CLIENT_SECRET` | qdrant.accessClientSecret | secret |
| `LINQ_API_TOKEN` | imessageLinq.apiToken | secret |
| `LINQ_WEBHOOK_SECRET` | imessageLinq.webhookSecret | secret |
| `SENTRY_DSN` | observability.sentryDsn | secret |

"config" rows are non-secret values (URLs, collection names) that travel the same vault path; the Secrets card shows them the way `GET /api/config` already does.

### Tunable knobs (`server/knob-map.ts`)

| Infisical name | Config field | Kind | Bounds |
|---|---|---|---|
| `BOTFLEET_JOBS_DEFAULT_MINUTES` | jobs.defaultMinutes | int | 1–360 |
| `BOTFLEET_JOBS_MAX_MINUTES` | jobs.maxMinutes | int | 1–360 |
| `BOTFLEET_JOBS_CPU_CORES` | jobs.cpuCores | int | 1–64 |
| `BOTFLEET_JOBS_MAX_SWAP_PERCENT` | jobs.admission.maxSwapPercent | float | 1–100 |
| `BOTFLEET_JOBS_MIN_FREE_DISK_MB` | jobs.admission.minFreeDiskMb | float | ≥ 0 |
| `BOTFLEET_WEBHOOK_HOT_DEFER_MINUTES` | jobs.webhookHotDeferMinutes | int | 1–720 |
| `BOTFLEET_TRACES_SAMPLE_RATE` | observability.tracesSampleRate | float | 0–1 |
| `BOTFLEET_AI_TRACES_SAMPLE_RATE` | observability.aiTracesSampleRate | float | 0–1 |
| `BOTFLEET_HTTP_TRACES_SAMPLE_RATE` | observability.httpTracesSampleRate | float | 0–1 |
| `BOTFLEET_UI_TRACES_SAMPLE_RATE` | observability.uiTracesSampleRate | float | 0–1 |
| `BOTFLEET_SPEND_CEILING_USD` | usage.spendCeilingUsd | float | ≥ 0 |
| `BOTFLEET_SPEND_CEILING_MIN_PRICED_SHARE` | usage.spendCeilingMinPricedShare | float | 0–1 |
| `BOTFLEET_INFISICAL_REFRESH_MINUTES` | infisical.refreshMinutes | int | 5–1440 |

Knob values are parsed from their vault strings and clamped to the bounds above; an unparsable value is logged and ignored.  Knob values are not secrets — they are already visible in Settings and `GET /api/config` — so only ids and counts travel the status views.

## What stays out (deliberately)

- **The store's own machine identity** (`infisical.clientId` / `clientSecret`, env `INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET`): a lock cannot hold its own key.  It lives in Settings > Secrets or the environment, never in the vault.
- **The store's own timeouts** (`OMB_INFISICAL_CALL_TIMEOUT_MS`, `OMB_INFISICAL_BOOT_TIMEOUT_MS`): they are read before the first login, so the vault they would come from does not exist yet.
- **Per-user settings**: bot and room configuration, per-bot transports, notification and UI preferences, per-user API keys.  These live in BotFleet's own database, never in Infisical.
- **Launch-time process parameters** (ports, data directories, updater paths, `BOTFLEET_TOKEN`): these shape the process before settings load and stay as env/flags.
- **Engine-internal tunables read once at module import** (e.g. `OMB_TURN_STALL_MS`): migrating them means changing import-time reads into resolved-config reads; tracked as follow-up work, not silently left as env.
- **Build-time constants** that never change at runtime.

## Cache, refresh and write-through mechanics

- The vault snapshot is published synchronously through `setInfisicalSnapshot` (filtered to mapped credential + knob names only — a stray row can never change behavior) and consumed by `loadConfig()`.  `server/index.ts` re-runs `loadConfig()` into the live `cfg` after every successful preload, refresh-with-reason, and Settings save.
- `GET /api/config` answers from the resolved `cfg`; the loopback Infisical status view reports `appliedFields` / `appliedKnobs` (ids only), `vaultCount`, `knobCount`, `unusedVaultNames`, staleness and the last error.
- A Settings save of a vault-managed knob with Write Through off is refused with 409 ("managed by Infisical — change it in Infisical, or turn on Write Through").  A save that changes the Infisical *connection* (project, site, environment, path, identity) in the same request as a knob write is refused with 400 — the knob would otherwise land in the old project.
- `saveConfig()` strips vault-managed values from anything bound for disk as a last line of defence, and warns with field ids.

## Rotating a value

Change it in Infisical (or save it in Settings with Write Through on).  The next background refresh — or `Sync Now` in Settings > Secrets — picks it up; credential changes that require a fleet rebuild set the `pendingProviderReload` flag and are applied on Sync Now or the next Settings save, never mid-turn.  Knob changes (job limits, sample rates, the refresh cadence) take effect on the next resolution with no rebuild: `infisical.start()` re-arms the poller when the cadence moves.

## For agents

`AGENTS.md` points here.  When adding a new tunable or credential: add it to the table in `server/knob-map.ts` or `server/secret-map.ts` (one row — the snapshot filter, resolution, provenance, write-through and status views all follow the table), add the default to the vault's `prod` environment when one exists, and cover it in `server/knob-map.test.ts` / `server/secret-map.test.ts`.  Never add a `process.env` read for a setting that belongs in these tables; never fetch Infisical per-request.

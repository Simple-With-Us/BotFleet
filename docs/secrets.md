# Secrets And Infisical

BotFleet can resolve its provider keys, tokens and URLs from an external
secret store — Infisical — instead of (or on top of) the values already
living on this computer.  It is entirely optional: an install that has never
been pointed at a project keeps working exactly as it always has, with
nothing new to configure and no new chrome in Settings.

This document is the map: where a credential can live, which one wins,
what the boot line and the two status surfaces say, and the refusal
BotFleet gives instead of silently reverting a save.

## Where Each Credential Lives

- **Infisical (canonical, when connected).**  An operator who wants one
  store of record for a fleet of installs points BotFleet at a project —
  environment `prod`, path `/` by default.  That project is the owner's own
  store; nothing ships a default project, so no two installs share a key
  unless the same operator deliberately connected both to the same one.
- **`~/.botfleet/config.json`** (or `$OMB_DATA_DIR/config.json`) and the OS
  keychain are where a single desktop install's own copy of each value
  lives.  This is still the primary store for an install that has no
  Infisical project configured, and it is where the desktop shell puts a
  credential entered in Settings.
- **GitHub Actions secrets** are a synced fallback for CI only.  Each
  workflow tries Infisical first and falls back to a same-named
  `GH_FALLBACK_<NAME>` step env var sourced from a GitHub secret, so a
  workflow keeps running green through an Infisical outage or a not-yet-
  seeded name.
- **Never in source.**  No credential this document names has ever been
  hardcoded in this repository; a `grep -r` for a real value should turn up
  nothing but this file's field names and the code that resolves them.

## Precedence

For a name Infisical holds, **Infisical wins** — over both this computer's
`config.json` and the process environment.  Underneath that, the ordering
BotFleet already had is untouched:

1. **Infisical** — a non-empty value for the field's Infisical name in the
   configured project/environment/path.
2. **Environment or file**, in whichever order that particular field already
   used before Infisical existed (`loadConfig()`'s hand-written overlay puts
   the environment above the file for a handful of legacy names; every other
   mapped field is read fresh from `config.json` and, at each call site that
   already checked an environment variable, falls back to it the same way it
   always did).
3. **None** — nothing configured anywhere; the feature that reads this field
   is simply off.

Only a name in the map below is ever applied, and a resolved value lands in
the in-memory config object only — never in `process.env` — so nothing new
rides into a spawned engine CLI.  A row in the vault under a name this table
does not recognize (`PATH`, `NODE_ENV`, a typo) is reported as
**"In Infisical, not used by BotFleet"** and otherwise ignored.

## Optional Connection And The Boot Line

`infisical.enabled` is explicit both ways, matching `ingress.enabled` and
`observability.enabled`:

- **Absent** → authentication defaults to `service-token`; Infisical stays
  inactive until a project and matching read credential are configured.  A
  project id alone never selects machine identity.
- **`false`** → off immediately.  The snapshot is cleared, every mapped
  field re-resolves from the environment and the file, and nothing restarts.

Infisical is optional.  An install with no Infisical configuration continues
to use its local configuration.  Once configured, it is enabled unless the
operator explicitly disables it.  The default authentication method is
`service-token`; machine identity is used only after the operator explicitly
selects `machine-identity` in this BotFleet install.

Absent an explicit Settings save, an install checks Infisical every 15
minutes (`refreshMinutes`, 5–1440), against site `https://app.infisical.com`,
environment `prod`, path `/`.

The server log line takes one of five forms, names and counts only —
never a value:

```
[infisical] enabled env=prod path=/ vault=9 applied=4 fields=composio.apiKey,usage.ingestUrl,usage.ingestToken,usage.readToken unused=5 ms=412
[infisical] disabled: not configured (configure a service token in Settings > Secrets)
[infisical] disabled by settings
[infisical] unavailable: <redacted error>; using environment and config values
[infisical] credentials changed (timer): xai.key — Sync Now or save Settings to rebuild bots
```

The last form is a **timer** refresh only: a scheduled sync that finds a
changed provider key never rebuilds a running bot on its own.  It records
the change and waits for an explicit **Sync Now** or a Settings save — both
user-initiated — before any provider is reloaded.  A field that does not
require a rebuild to take effect (the voice key, the usage tokens, the DSN)
never produces this line at all.

Boot itself cannot hang on Infisical: the initial fetch is bounded (8
seconds per call, 12 seconds overall by default, overridable with
`OMB_INFISICAL_BOOT_TIMEOUT_MS`) and always resolves one way or the other.
A boot-time failure falls back to the environment and file values with the
error recorded; a later refresh failure keeps the last good snapshot and
marks it stale, so a network blip never swaps credentials out from under a
running fleet.

## The Secret Map

| Field | Infisical name | Env aliases (highest priority first) | Secret | Reloads fleet |
|---|---|---|---|---|
| `xai.key` | `XAI_API_KEY` | `XAI_API_KEY` | yes | yes |
| `openaiCompat.key` | `OPENAI_COMPAT_API_KEY` | `OPENAI_COMPAT_API_KEY` | yes | yes |
| `openaiCompat.url` | `OPENAI_COMPAT_URL` | `OPENAI_COMPAT_URL` | no | yes |
| `composio.apiKey` | `COMPOSIO_API_KEY` | `COMPOSIO_API_KEY` | yes | yes |
| `box.token` | `BOX_TOKEN` | `BOX_TOKEN` | yes | yes |
| `opencodeGo.apiKey` | `OPENCODE_API_KEY` | `OPENCODE_API_KEY` | yes | yes |
| `tts.key` | `OMB_TTS_KEY` | `OMB_TTS_KEY` | yes | no |
| `azureSpeech.key` | `AZURE_SPEECH_KEY` | `AZURE_SPEECH_KEY` | yes | no |
| `azureSpeech.region` | `AZURE_SPEECH_REGION` | `AZURE_SPEECH_REGION` | no | no |
| `metaSpeech.key` | `META_SPEECH_API_KEY` | `META_SPEECH_API_KEY` | yes | no |
| `groq.key` | `GROQ_API_KEY` | `GROQ_API_KEY` | yes | no |
| `assemblyai.key` | `ASSEMBLYAI_API_KEY` | `ASSEMBLYAI_API_KEY` | yes | no |
| `imageGen.key` | `OMB_OPENAI_IMAGE_KEY` | `OMB_OPENAI_IMAGE_KEY` | yes | no |
| `deepseek.key` | `DEEPSEEK_API_KEY` | `DEEPSEEK_API_KEY` | yes | no |
| `usage.ingestUrl` | `USAGE_MONITOR_INGEST_URL` | `USAGE_MONITOR_INGEST_URL` | no | no |
| `usage.ingestToken` | `USAGE_MONITOR_INGEST_TOKEN` | `USAGE_MONITOR_INGEST_TOKEN`, `USAGE_INGEST_TOKEN` | yes | no |
| `usage.readToken` | `USAGE_READ_TOKEN` | `USAGE_READ_TOKEN` | yes | no |
| `qdrant.url` | `OMB_RECALL_URL` | `OMB_RECALL_URL`, `RECALL_URL`, `QDRANT_URL` | no | yes |
| `qdrant.apiKey` | `OMB_RECALL_API_KEY` | `OMB_RECALL_API_KEY`, `RECALL_API_KEY`, `QDRANT_API_KEY` | yes | yes |
| `qdrant.collection` | `OMB_RECALL_COLLECTION` | `OMB_RECALL_COLLECTION`, `RECALL_COLLECTION`, `QDRANT_COLLECTION` | no | yes |
| `qdrant.accessClientId` | `OMB_RECALL_ACCESS_CLIENT_ID` | `OMB_RECALL_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_ID` | no | yes |
| `qdrant.accessClientSecret` | `OMB_RECALL_ACCESS_CLIENT_SECRET` | `OMB_RECALL_ACCESS_CLIENT_SECRET`, `CF_ACCESS_CLIENT_SECRET` | yes | yes |
| `observability.sentryDsn` | `SENTRY_DSN` | `SENTRY_DSN`, `BOTFLEET_SENTRY_DSN` | yes | no |
| `observability.sentryFleetDsn` | `SENTRY_FLEET_DSN` | `SENTRY_FLEET_DSN` | yes | no |

This table lives once, in code, at `server/secret-map.ts`'s `SECRET_FIELDS` —
this list is kept in step with it by hand, so treat the source as
authoritative if the two ever disagree.

**Deliberately not mapped:** MiniMax (no config section — `MINIMAX_API_KEY`
or `~/.mmx/config.json` only), the Composio managed-broker pair (provisioned
per install over its own live IPC channel), the Remote Access connector
token (Electron-only), `instances[].environment`, and `OMB_COMMS_TOKEN` /
`OMB_CONTROL_TOKEN` (random per boot).  None of these can be usefully shared
through a vault, so none of them is in the table above.

## Refusal And Write-Through

Saving a field through Settings while Infisical holds that name is either
refused or written through — **never accepted and then silently reverted by
the next sync.**

- **Write Through off (the default).**  `PATCH /api/config` touching a
  vault-managed field returns **409** and saves nothing:

  ```json
  {
    "error": "<Field> is managed by Infisical (prod).  Change it in Infisical, or turn on Write Through in Settings > Secrets.",
    "field": "usage.ingestToken",
    "infisicalName": "USAGE_MONITOR_INGEST_TOKEN"
  }
  ```

- **Write Through on.**  The new value is written to Infisical first; only
  once that succeeds is the local copy blanked to `""`, so the vault stays
  the one canonical copy.  A failed write reaches the caller as a 502 and
  nothing is saved locally either.
- **Clearing a vault-managed field is always refused**, in both modes — "Remove
  it in Infisical." — because an empty local value can never mean "delete
  this from the vault."  Write-through never deletes.

## The Three HTTP Routes

All three are loopback-only, in the same block as `/api/telemetry/*` — the
existing loopback gate and origin check apply, and Remote Access can tunnel
them to an authenticated session but never to the open internet.

```
GET  /api/infisical/status
```

Returns `{ infisical: InfisicalStatusView, fields: FieldRow[] }` — booleans,
counts, names and ids.  `fields` walks the secret map; a `secret: true`
field's `value` is always `null`, never the real value.

BotFleet accepts at most 32 exact-folder source routes.  Each entry names a project, optional environment and exact Infisical folder path, plus a read-token locator (`tokenFile` or `tokenEnv`) and optional separate write-token locator (`writeTokenFile` or `writeTokenEnv`).  A folder path matches that folder only, including `/` as the root; it grants no recursive access to descendants.  A source token is selected only for a matching project, environment, and folder, and a matching source takes precedence for that operation.  Missing or rejected source credentials fail that operation closed; the operation never borrows the primary token or machine identity.  Token values are read from the named environment variable or owner-only file at use time and are never included in status.  A `tokenFile` or `writeTokenFile` must be an absolute path inside the BotFleet config directory (the directory containing `config.json`, `~/.botfleet` or `$OMB_DATA_DIR`) or one of its subdirectories; it must be a regular, non-symlink file with no group or other read/write permission.  Status reports locator metadata and whether a locator is configured without reading token files or exposing values.

For each Infisical project, BotFleet allows one distinct read-token reference
and at most one distinct write-token reference, reused across all folder and
environment routes.  The effective primary service-token credentials count
toward those per-project limits when they are selected for the primary scope.
`INFISICAL_READ_SOURCES` is parsed as configuration input and receives the
same route and credential-reference validation; the JSON environment override
cannot bypass these limits.

The status view reports the selected `authMethod`, primary read/write-token
presence, and configured source locator metadata.  A missing or rejected
primary token fails the requested Infisical operation; it never falls back to
machine identity.  A missing or rejected matching source token also fails
closed instead of borrowing a primary token.  Machine identity is attempted
only when this install explicitly selects `machine-identity`.

```
POST /api/infisical/sync
```

Refreshes from the vault (`refresh("manual")`), re-resolves every mapped
field, reloads any provider whose credentials actually changed, and returns
the same payload `GET /api/infisical/status` would.  This is what the
Secrets card's **Sync Now** button calls.

```
POST /api/infisical/test
```

Logs in and lists secret **names** only (`viewSecretValue=false` on the
wire) — proves the identity and project id are correct without ever
populating the snapshot.  Returns `{ ok, error, secretCount, names }`.  This
is what **Test Connection** calls.

The probe tests the credential selected by this install's explicit auth
method and exact source scope.  A refused service token is reported as a
failure and is never retried with machine identity.  Rotation takes effect
after the next settings save or refresh.

`GET /api/config` separately carries a small `infisical` block —
`configured`, `enabled`, `authMethod`, `writeThrough`, `environment`,
`hasClientSecret`, `hasToken`, `hasWriteToken`, `managedCount`, `lastSyncAt`,
`stale`, `hasError`, `pendingProviderReload` —
because that frame is broadcast to every open window; the project id, site
URL and vault names live only on the loopback status route above.

## CI: The Composite Action

`.github/actions/infisical-secrets` wraps `scripts/infisical-fetch.mjs`, a
dependency-free Node script — no SDK, no CLI install — so the same action
runs unmodified on `macos-latest`, `windows-latest` and `ubuntu-24.04`
GitHub-hosted runners.  A workflow step passes `names`, an optional
`required` subset, the project id, environment, secret path and the
identity, plus a `GH_FALLBACK_<NAME>` env entry per name it wants a GitHub
secret to cover:

```yaml
- uses: ./.github/actions/infisical-secrets
  with:
    names: SENTRY_AUTH_TOKEN
    required: SENTRY_AUTH_TOKEN
    project-id: ${{ secrets.INFISICAL_PROJECT_ID }}
    token: ${{ secrets.INFISICAL_SENTRY_TESTFLIGHT_READ_TOKEN }}
  env:
    GH_FALLBACK_SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
```

Each resolved value is masked (`::add-mask::`) and exported into
`$GITHUB_ENV` before the step ever logs anything else.  A name that is
empty from both Infisical and its `GH_FALLBACK_<NAME>` produces a
`::warning::` unless it is in `required`, in which case the job fails with
`::error::`.  `secrets.*` is never referenced inside an `if:` condition —
GitHub's dispatch parser rejects that with an HTTP 422.

## BotFleet's Own Infisical Authentication

Infisical is optional.  When enabled, BotFleet defaults to the `service-token`
auth method, using `INFISICAL_TOKEN` for reads and the separate
`INFISICAL_WRITE_TOKEN` for writes.  A missing or rejected token never
activates machine identity; an operator must explicitly select
`machine-identity` for this app.  Neither auth method is stored in the vault
it unlocks.

The approved launch helper can provide the managed harness token bindings
`BOTFLEET_HARNESS_INFISICAL_READ_TOKEN` and optional
`BOTFLEET_HARNESS_INFISICAL_WRITE_TOKEN`.  Their registry and live helper
authentication handoff remain pending AFC-600; do not treat the source
fixtures as proof of provisioning or live access.  See the dated
[Nov 3 service-token binding reconciliation](rollouts/2026-11-03-service-token-bindings.md)
for each consumer, exact-scope requirements, and remaining verification.

When a desktop save includes new credentials, Settings first persists the
connection metadata with Infisical disabled, then writes credentials through
the encrypted credential store, and finally persists the requested toggle.  If an encrypted credential write fails, the staged connection stays disabled.

## The Migration Script

`scripts/infisical-migrate.mjs` is a one-way seeding helper an operator runs
by hand — nothing in the product calls it.  It reads the same config
`loadConfig()` would (`~/.botfleet/config.json` or `$OMB_DATA_DIR`), walks
the secret map, and for every field with a non-empty local value reports
whether Infisical already holds that name and whether the value matches, by
comparing sha256 digests — never the raw values:

```
$ node --experimental-strip-types scripts/infisical-migrate.mjs
Infisical prod at / on https://app.infisical.com (dry run -- pass --apply to write):
  composio.apiKey -> COMPOSIO_API_KEY  (local value present, vault: absent)
  usage.ingestUrl -> USAGE_MONITOR_INGEST_URL  (local value present, vault: absent)
  usage.ingestToken -> USAGE_MONITOR_INGEST_TOKEN  (local value present, vault: absent)
  usage.readToken -> USAGE_READ_TOKEN  (local value present, vault: absent)
```

**Dry run is the default and prints only this report.**  `--apply` upserts
every row not already `present-and-same`, one name at a time, printing
`wrote NAME`, `skipped NAME (unchanged)`, or `failed NAME: <redacted
error>`.  It never touches handoff files or accepts credentials on the
command line.  It requires the primary `INFISICAL_TOKEN` for its read and
uses only the separate `INFISICAL_WRITE_TOKEN` for `--apply`; it never
borrows the read token for writes or falls back to machine identity.  It
does not read configured source locator tokens; use the app's scoped
write-through path for those sources.  See the [Nov 3 service-token binding
reconciliation](rollouts/2026-11-03-service-token-bindings.md) for the
pending live provisioning boundary.

---

Two spaces between sentences and Title Case section headings are the house
style for this file, matching the rest of `docs/`.  This document does not
change `AGENTS.md`; the protocol for agents working in this repo lives
there unmodified.

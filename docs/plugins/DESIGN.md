# BotFleet Plugin System Design

A drop-in extension mechanism for BotFleet that lets a person add, remove,
update, enable, and disable functionality without shipping a pull request
to this repo.  Plugins are user data, not repo code.

This document is the contract.  The code mirrors it.  Open questions sit
at the end and are deliberately not guessed.

## Goals

1.  Adding, removing, updating, enabling, or disabling a plugin never
    requires a pull request to BotFleet itself.
2.  Plugin manifests are versioned and validated.  A validation error
    names the field, says what's wrong, and says what was expected.
3.  The host exposes stable data and capability APIs.  Plugins do not
    reach into BotFleet internals.
4.  Consistent with the existing architecture (skills trust model,
    `server/index.ts` route dispatch style, zod validation in `shared/`).
5.  Ship with one example plugin that exercises the full lifecycle:
    install, enable, render or use, update, remove.

## Non-Goals

A plugin system is a wide surface.  v1 deliberately keeps it small.

*   No plugin marketplace or store backend.  No ratings.  No discovery
    service.
*   No raw UI from plugins.  Plugins contribute data; the host renders it.
    No React from a plugin lands in the webview.
*   No hot-reload of plugin code beyond an explicit reload endpoint.
*   No plugin code in the server process.  Each enabled plugin runs in
    its own sandboxed child process (see § Trust Model).  The trust
    model on top of that (imports land disabled; the user enables them
    after reading the manifest) mirrors skills.
*   No new `process.env` reads.  Plugin state is user data; it lives in
    the registry directory under `DATA_DIR`.

## Architecture

```
        ┌──────────────────────────────────────┐
        │  Web UI (Vite / React)               │
        │   - PluginsManagerView (this lane)   │
        │   - Existing PluginsPanel (untouched)│
        └──────────────┬───────────────────────┘
                       │  fetch /api/plugins/*
                       ▼
        ┌──────────────────────────────────────┐
        │  server/index.ts  route dispatch     │
        │   /api/plugins, /api/plugins/:name,  │
        │   /api/plugins/:name/{enable,        │
        │     disable,update},                  │
        │   /api/plugins/:name/cards,           │
        │   /api/plugins/:name/commands         │
        └──────────────┬───────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────────────┐
        │  server/plugins.ts  lifecycle        │
        │   install, enable, disable, update,  │
        │   remove, list, get, reload, runCmd  │
        └────┬──────────┬──────────┬───────────┘
             │          │          │
             ▼          ▼          ▼
       plugin-     plugin-     plugin-loader.ts
       fetch.ts    registry.ts (ESM dynamic import,
       (git URL,  (registry.json handed a frozen
       local      on disk)   PluginHost object)
       folder)
```

The skill subsystem already covers half of this story: it scans text,
gates imports on a disabled-by-default flag, and ships a folder and
git-URL fetch path.  Plugin reuse is deliberate, not accidental.

## Manifest

Every plugin has a `botfleet-plugin.json` at its top level.  Schema
(`shared/plugin-manifest.ts`):

```jsonc
{
  "name": "fleet-overview",        // required, slug, unique
  "version": "1.0.0",              // required, semver
  "description": "Bot counts by status.",  // required, <= 280 chars
  "author": "Jay Wedgeworth",      // optional, free string
  "license": "Apache-2.0",         // optional, free string

  "botfleet": ">=1",               // required, semver range
  "entry": "plugin.mjs",           // required, path inside plugin dir
  "capabilities": [                // optional, declared permissions
    "read.bots",
    "read.status"
  ],

  "contributes": {                 // optional, declarative only
    "cards": [
      {
        "id": "fleet-overview",    // unique within the plugin
        "title": "Fleet Overview",
        "description": "Bot counts by status.",
        "layout": "stat-grid",     // hint for the host renderer
        "fields": ["total", "running", "stopped"]
      }
    ],
    "commands": [
      {
        "name": "fleet",           // slash command name
        "description": "Summarize the fleet.",
        "args": []                 // optional positional hints
      }
    ]
  }
}
```

### Field rules

*   `name`: 1 to 64 characters, lowercase alphanumerics with single
    hyphens.  Mirrors the skill-name gate.  Regex:
    `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
*   `version`: strict semver `MAJOR.MINOR.PATCH`.  Used for install
    ordering and the update gate.
*   `botfleet`: semver range.  A git limit v1 uses `">=1"` because
    `HOST_API_VERSION = 1`.
*   `entry`: relative path inside the plugin directory.  Resolved at
    load time.  Must end in `.mjs` or `.js`; dynamic `import()` will
    refuse anything else.
*   `capabilities`: each entry is one of a fixed allowlist.  v1 only:
    `read.bots`, `read.status`, `read.config`.  Unknown capabilities
    fail validation with the field name.
*   `contributes.cards[].id`: unique per plugin.  The host prefixes the
    `id` with the plugin name to keep it unique fleet-wide.
*   `contributes.commands[].name`: 1 to 32 chars, lowercase alphanumerics
    and hyphens.  No slash; the host supplies it.

### Validation errors

Validation uses zod and returns a typed `PluginManifestParseError`:

```ts
{
  error: "invalid manifest",
  issues: [
    { field: "version", message: "expected semver MAJOR.MINOR.PATCH, got \"1.0\"" },
    { field: "contributes.cards[0].id", message: "duplicate id \"fleet-overview\" within plugin" }
  ]
}
```

`field` is a dotted path.  `message` includes the got value and what
was expected.  Every API that takes a manifest responds with this shape
so the UI can render one row per issue.

## Registry

The registry lives outside the repo, at
`<DATA_DIR>/plugins/<name>/`.  One folder per plugin.  A single
`registry.json` file at `<DATA_DIR>/plugins/registry.json` records
state across plugins.

```jsonc
// <DATA_DIR>/plugins/registry.json
{
  "version": 1,
  "plugins": {
    "fleet-overview": {
      "name": "fleet-overview",
      "version": "1.0.0",
      "enabled": false,            // disabled until the user enables
      "installedAt": "2026-10-04T12:00:00.000Z",
      "updatedAt": "2026-10-04T12:00:00.000Z",
      "source": {
        "kind": "folder",           // "folder" | "git"
        "path": "<plugin-folder>",
        "ref": null
      },
      "warnings": []                // reserved for the future scan pass
    }
  }
}
```

The on-disk tree for one plugin:

```
<DATA_DIR>/plugins/<name>/
  botfleet-plugin.json   // the manifest (validated on every load)
  plugin.mjs             // the entry the manifest declares
  (other plugin files)
```

### Why a registry, not env vars

Plugin enablement is user data.  It must move with the user's fleet
under whatever sync and backup story they have, and it must not be
overwritten by `loadConfig()`.  The same reason `skills/skills.json`
sits next to `SKILL.md` rather than living in `config.json`.

### Write safety

*   Writes go through `writeFileSync` after a `mkdirSync` with mode
    `0o700`.
*   The registry file is mode `0o600`.  A corrupt file is read as an
    empty registry rather than throwing.

## Host API

Plugins never receive BotFleet internals.  They receive a frozen
`PluginHost` object built inside their sandbox process for each call,
from a snapshot the server has already filtered through the declared
capabilities and the secret-key redaction.

```ts
interface PluginHost {
  /** Host API version.  Plugins gate themselves on this. */
  readonly version: 1;

  /** Plugin-local logger.  The message text stays inside the sandbox;
   *  the server records only the level, the length, and a hashed plugin
   *  id, so a plugin cannot write arbitrary text into the host logs. */
  log(level: "info" | "warn" | "error", message: string): void;

  /** Read access to the bot store.  Returns a plain summary, not the
   *  live store object — plugins can never mutate state. */
  getBots(): ReadonlyArray<{
    id: string;
    name: string;
    status: string;
    driver: string;
  }>;

  /** Read access to a small allowlist of non-secret settings.
   *  `key` must be one of the values returned by `listConfigKeys()`.
   *  Returns undefined for unknown or unset keys. */
  config: {
    get<T = unknown>(key: string): T | undefined;
    listKeys(): readonly string[];
  };
}
```

The host API is frozen with `Object.freeze` so a plugin cannot smuggle
references back into BotFleet through reassignment.  The first version
ships only reads.  Writes come later, behind a more careful trust gate.

### Version gate

`HOST_API_VERSION = 1`.  The manifest's `botfleet` constraint is checked
against it on load.  A plugin whose manifest says `"botfleet": ">=2"`
is refused at load time and is not enabled.

## Contribution Points

v1 supports two declarative contribution points.  Both are host-rendered;
no plugin React lands in the webview.

### Dashboard cards (declarative)

A plugin's manifest declares one or more cards.  Each card describes
its data and a layout hint.  The host renders the card with its own
components, so a malicious plugin cannot draw an arbitrary UI.

```jsonc
"contributes": {
  "cards": [
    {
      "id": "fleet-overview",
      "title": "Fleet Overview",
      "description": "Bot counts by status.",
      "layout": "stat-grid",
      "fields": ["total", "running", "stopped", "errored"]
    }
  ]
}
```

When the host wants the card's data, it calls the plugin's exported
`getCardData(cardId)` function (if present) and renders whatever
shape that returns against the declared fields.  A plugin that
declares no `getCardData` shows static placeholder text — the card still
ships, the user sees it, but it has nothing dynamic to render.

### Slash commands (declarative + handler)

A plugin's manifest declares one or more commands.  The host invokes
the plugin's `runCommand(name, args)` export when a user types
`/<plugin-command-name> <args>` in a bot's chat.  The handler returns a
text string; the host appends it to the bot's turn output as a system
message.  Plugins cannot mutate the bot's history directly.

```ts
// plugin.mjs
export async function runCommand({ args, host }) {
  const bots = host.getBots();
  return `Fleet has ${bots.length} bot${bots.length === 1 ? "" : "s"}.`;
}
```

### What plugins cannot do in v1

*   Render React or HTML.
*   Mutate the bot store, registry, or filesystem.  The sandbox grants
    read access to the plugin's own directory and nothing else, and no
    write access at all.
*   Spawn processes, start worker threads, or load native addons.
*   Open network sockets.  This is an authoring rule, not yet an
    enforced one: see open question 1.
*   Register hooks, listeners, or timers that outlive the command
    invocation.  Commands are synchronous, awaited in line.
*   Read secrets, tokens, or credentials from the host.

## Lifecycle

```
install(source) ──►  validate manifest  ──►  fetch files  ──►  write tree  ──►  registry (enabled=false)
                                                                            │
                                                                            ▼
                                                                       (user clicks enable)
                                                                            │
                                                                            ▼
enable(name) ────►  registry load  ──►  dynamic import  ──►  hand PluginHost  ──►  enabled=true
                                                                            │
                                                                            ▼
                                          (user invokes /<cmd> or opens card)
                                                                            │
                                                                            ▼
use(name) ───────►  card data via getCardData()  ──►  command via runCommand()  ──►  host renders
                                                                            │
                                                                            ▼
                                                                       (user clicks update)
                                                                            │
                                                                            ▼
update(name) ─────►  re-fetch from source  ──►  validate  ──►  semver check (warn on downgrade)
                                                                            │
                                                                       ──►  replace tree  ──►  reload
                                                                            │
                                                                            ▼
                                                                       (user clicks disable)
                                                                            │
                                                                            ▼
disable(name) ───►  drop module reference  ──►  registry (enabled=false)
                                                                            │
                                                                            ▼
                                                                       (user clicks remove)
                                                                            │
                                                                            ▼
remove(name) ─────►  rm tree  ──►  delete registry entry
```

`install`, `update`, `enable`, `disable`, and `remove` are idempotent.
`install` returns the listing (with warnings) so the UI can render the
same review screen it already uses for skills.

## API Routes

All routes follow the existing dispatch style in `server/index.ts`.
Body shape mirrors the existing skills routes (same install and review
flow; the route path itself stays an implementation detail).

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET`    | `/api/plugins`                | -                  | `PluginListing[]` |
| `GET`    | `/api/plugins/:name`          | -                  | `PluginListing` |
| `POST`   | `/api/plugins/install`        | `{ source }`       | `PluginListing` |
| `POST`   | `/api/plugins/:name/enable`   | -                  | `PluginListing` |
| `POST`   | `/api/plugins/:name/disable`  | -                  | `PluginListing` |
| `POST`   | `/api/plugins/:name/update`   | -                  | `PluginListing` |
| `POST`   | `/api/plugins/:name/reload`   | -                  | `PluginListing` |
| `DELETE` | `/api/plugins/:name`          | -                  | `{ removed: true }` |
| `GET`    | `/api/plugins/:name/cards/:id` | -                 | `PluginCardData` |
| `POST`   | `/api/plugins/:name/commands/:cmd` | `{ args }`   | `{ text: string }` |

`source` is the same shape `parseSkillSource` accepts: a GitHub
`owner/repo`, full URL, blob URL, or absolute local folder path.  Git
URLs are fetched via the GitHub contents API (same as
`skill-fetch.ts`); folder paths read directly off disk (same as
`skill-folder.ts`).

Validation failures respond with HTTP 400 and the typed
`PluginManifestParseError` shape.  Unknown plugin names respond with
HTTP 404.  Disabled plugin accesses (cards, commands) respond with
HTTP 409 and a message that says the plugin is disabled.

## Web UI

A `PluginsManagerView` lives at `src/components/PluginsManagerView.tsx`.
It opens from the existing Plugins modal's secondary action button
("Manage Plugins").  The existing `PluginsPanel` (Composio connectors)
stays untouched.

The view lists installed plugins, supports install from a source,
enable/disable toggle, update, remove, and surfaces validation
errors readably.  Card rendering happens against the main page; the
view itself only renders the management surface.

The example plugin's card lives in a side panel on the chat view,
right of the bot list.  Same render path real plugins will use.

## Trust Model

The plugin model mirrors skills:

1.  Imports land **disabled**.  Nothing a plugin contributes reaches
    any host surface until a person enables it after reading the
    manifest.
2.  Capabilities are declared in the manifest and surfaced in the UI.
    A plugin that tries to read something it did not declare gets an
    empty result and a warning.
3.  The host API is read-only and frozen.  A plugin cannot smuggle a
    reference back into BotFleet through reassignment.
4.  The plugin module never runs in the server process.  The loader
    (`server/plugin-loader.ts`) spawns one child per enabled plugin
    (`server/plugin-sandbox-child.ts`) with an empty environment, the
    Node permission model (read access to the child script and the
    plugin's own directory only; no filesystem writes, no child
    processes, no worker threads, no native addons), a capped heap, and
    a per-call deadline that kills the child when a handler overruns.
    The child imports the plugin, reports which handlers it exports,
    and answers host calls from the per-call snapshot.  Every message
    the child sends back is parsed with a strict zod schema; anything
    else kills the child.  Plugin log text and thrown error messages
    never cross back; the server sees levels, lengths, and stable
    reason codes.  If the running Node build has no permission model,
    the loader refuses to run plugin code at all.

## Verification

*   Manifest unit tests cover valid + invalid inputs and assert the
    `field` and `message` of every issue.
*   Registry lifecycle test exercises install, enable, host-API access,
    update, disable, remove in an isolated fixture (`mkdtemp`,
    `OMB_DATA_DIR`).
*   The example plugin is the smoke fixture.  A short driver script
    boots the registry, installs the example fixture plugin, enables
    it, calls its card data and slash command through the host API,
    updates to a bumped version, and removes it.  The script is
    reproducible and lives at `scripts/plugin-smoke.mjs`.

## Open Questions For The Owner

1.  **Outbound network from the sandbox.**  Node's permission model
    does not restrict outbound sockets, so a plugin can still open a
    connection.  It has no credentials, no environment, and nothing
    readable outside its own directory to send, but blocking egress
    needs an OS-level mechanism (a network namespace on Linux, a
    sandbox profile on macOS).  Should v1 ship with that, or should v1
    be declarative-only (manifest contributions, no JS at all)?
2.  **Plugin UI ceiling.**  Is host-rendered cards + slash commands
    the permanent ceiling, or will plugins eventually contribute raw
    UI (their own React)?
3.  **Distribution and signing.**  v1 records source URL + ref only.
    Is a checksum pin or a git-host allowlist wanted?  Are signed
    releases in scope?

## Files Added / Changed

```
shared/plugin-manifest.ts                  NEW
shared/plugin-manifest.test.ts             NEW
server/plugin-types.ts                     NEW
server/plugin-registry.ts                 NEW
server/plugin-loader.ts                   NEW
server/plugin-fetch.ts                    NEW
server/plugin-folder.ts                   NEW
server/plugins.ts                         NEW
server/plugins.test.ts                    NEW
server/plugin-manifest.test.ts            NEW  (or shared/plugin-manifest.test.ts)
server/plugin-registry.test.ts            NEW
server/plugin-loader.test.ts              NEW
server/plugin-sandbox-child.ts            NEW  (sandboxed child process)
server/plugin-sandbox-protocol.ts         NEW  (zod IPC schemas)
server/plugin-sandbox.test.ts             NEW
server/proxy-paths.ts                     CHANGED  (sandbox child path)
scripts/bundle-server.mjs                 CHANGED  (bundle sandbox child)
tests/e2e/visual.spec.ts                  CHANGED  (plugin manager screenshot)
server/index.ts                           CHANGED  (route dispatch)
src/components/PluginsManagerView.tsx     NEW
src/components/CardRenderer.tsx           NEW
src/components/PluginsManagerView.test.tsx NEW
src/App.tsx                               CHANGED  (mount manager view + add nav)
src/state/store.tsx                       CHANGED  (add plugin manager view flag)
scripts/plugin-smoke.mjs                  NEW
docs/plugins/DESIGN.md                    NEW
docs/plugins/example-plugin/botfleet-plugin.json  NEW
docs/plugins/example-plugin/plugin.mjs           NEW
docs/plugins/example-plugin/README.md            NEW
tests/fixtures/example-plugin/botfleet-plugin.json NEW
tests/fixtures/example-plugin/plugin.mjs          NEW
```

Existing `PluginsPanel.tsx` (the Composio connectors panel) is **not**
modified.
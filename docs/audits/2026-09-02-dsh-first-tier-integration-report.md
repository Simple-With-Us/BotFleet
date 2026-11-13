# DSH as a First-Tier BotFleet Engine — Integration Gap Report

**Date:** 2026-09-02
**Scope:** How DeepSeek Harness (the `dsh` harness / `dshAgent` driver) is — and is not —
functioning like the other platform CLIs (`claude`, `codex`, `agy`, and the ACP siblings
`deepseek`/`kimi`/`grok`/`cursor`/…) inside BotFleet, and what it would take to make it a
first-tier, equivalent option for bot fleets.
**Method:** Static analysis of `server/contracts.ts`, `server/drivers/**`, `server/model-fallback.ts`,
`server/config.ts`, `server/index.ts`, picker/UI copy, plus ground-truth inspection of the real DSH
runtime (`~/apps/dsh-runtime`, the pinned `@deepseek-ai/dsh` binary and its `dsh-acp.py` ACP bridge).
Read-only; no product code changed.

---

## 1. Executive summary

DeepSeek Harness is **not currently functional in BotFleet**, and it is far below the
capability bar of the other fleet engines. Three distinct defects stack on top of each other:

1. **Every DSH turn hard-fails the ACP auth gate** (a config bug: unconditional
   `pickAuthMethod: () => null` combined with `authFailure: "fail"`), independent of whether the
   user is actually authenticated. *(Verified by control-flow reading of `acp/core.ts:571–584`.)*
2. **The thing BotFleet spawns does not speak ACP.** The pinned `@deepseek-ai/dsh` npm binary has no
   `acp` subcommand (verified: zero `acp` references in its `lib/bin.js`; the runtime README states
   "`dsh acp` is not a CLI command"), and on this machine there is no `dsh` executable on PATH at all
   (`which -a dsh` → empty). The only working ACP server for DSH is a private, machine-specific
   Python bridge (`~/apps/dsh-runtime/dsh-acp.py`), which BotFleet's default `cli: "dsh"` never reaches.
3. **Even when driven through that working bridge, the bridge cannot deliver what a first-tier
   engine needs:** it advertises `authMethods: []`, replies `{}` (success) to unknown methods like
   `session/set_model`, ignores `mcpServers`, fabricates non-resumable UUID sessions, never reports
   token usage, and never emits tool/permission events. Model picks, multi-turn memory, MCP tools,
   approvals, and telemetry are all silently lost.

Because of (1)–(3), the driver's advertised capability flags and the app's own onboarding copy
(`src/components/ModelPicker.tsx`, `EnginesSettings.tsx`: "…or the DeepSeek Harness (`dsh`) instead"
for full tool support) **over-promise**: a `dsh` bot cannot complete a turn today, let alone run
tools. Meanwhile the shipped default fleet *does* include a `dsh` instance (`server/config.ts`
DEFAULT_FLEET) but does **not** include the far more complete sibling — the DeepSeek Code CLI ACP
driver (`acp/deepseek.ts`) — so the least-working DeepSeek is the one that ships.

The good news: the driver sits on a strong shared ACP core (`acp/core.ts`) that already gives every
ACP harness agents/composio/computer/local-computer MCP mounting, streaming, and the permission
broker. Closing the gap is mostly: (a) three config fixes in `acp/dsh.ts`, (b) a real decision about
which process actually speaks ACP for DSH (ship the bridge, or upstream `dsh acp`), and
(c) filling the same capability checklist the DeepSeek Code/Kimi/Grok siblings already fill. A
phased plan is in §8 and a concrete file-by-file change list in §9.

---

## 2. Terminology — there are three different "DeepSeek"s in BotFleet

| Name in app | Driver | File | What it is | In default fleet? |
|---|---|---|---|---|
| **DeepSeek Harness (`dshAgent`)** | `DshAgentDriver` | `server/drivers/acp/dsh.ts` | This report's subject: the local `dsh` harness (Cordis-based agent runtime), models `deepseek-v4-*` | ✅ `dsh` (`config.ts:461,486`) |
| **DeepSeek** (`deepseekAgent`) | `DeepSeekAgentDriver` | `server/drivers/acp/deepseek.ts` | Moonshot **DeepSeek Code CLI** (`deepseek acp`) on the subscription login; models `deepseek-code/*` | ❌ registered only |
| **DeepSeek API** (`deepseek`) | `DeepSeekDriver` | `server/drivers/deepseek.ts` | Native HTTP API driver (API key); retired `deepseek-chat`/`reasoner` issue (audit D4) | ❌ registered only |

This report uses **DSH** for the harness. Cross-referencing with prior audits
(`docs/audits/2026-08-31-full-stack-audit.md` D1–D4, `docs/audits/2026-09-01-delta-audit.md` D3–D4)
and the git history (commit `e270781` "remove non-working dsh agent", later re-added "discoverable
DeepSeek harness" in `fe2605a`) shows the DSH path has been in and out of the product already
because it was non-working; the re-add kept the same architecture.

---

## 3. The bar: what "first-tier" looks like today

From `server/drivers/claude.ts` (1186 ln), `codex.ts` (665 ln), `antigravity.ts` (787 ln), and the
ACP siblings (`acp/deepseek.ts`, `acp/kimi.ts`, `acp/grok.ts`, …), a first-tier local engine has:

- **A real spawn target.** `claude`/`codex`/`agy` are real CLI binaries the driver launches with a
  known protocol (stream-json / JSON-RPC app-server / ACP subcommand).
- **Model catalog.** Claude: static + `~/.claude/settings.json` + local injects. Codex: live
  `model/list` from the CLI's app-server + toml/catalog files. Antigravity: static + user settings +
  injects. ACP siblings: `resolveModels` probing CLI config (deepseek/kimi/grok read the CLI's own
  config + `mergeLocalInject`).
- **Login detection + onboarding.** `claude auth status --json`, `codex login status`; per-platform
  `install.command` + `signInCommand` + `docsUrl` (Claude/Codex/Antigravity and every ACP sibling
  except DSH).
- **Per-turn model fidelity.** Model actually applied (argv for most; `session/set_model` with
  confirmation and **throw-on-mismatch** for grok/hermes/droid/cursor).
- **Conversation continuity.** `claude --resume`/`codex thread/resume`/`agy --conversation`/
  `session/load` — turn N+1 sees turn N.
- **MCP tools** (computer, Composio, agents, phone) either per-session (`claude --mcp-config`,
  ACP `session/new.mcpServers`) or carefully leased (agy global-config upsert), with secrets only in
  env and honest `capabilities.*Mcp` flags gated on what can actually fire.
- **Rich event stream.** assistant + reasoning deltas, tool items, `thread.token-usage.updated`,
  usage/cost on `turn.completed` — feeding tool-run chips, telemetry, and the quota/fallback engine.
- **Approval fidelity.** Interactive brokers for claude/codex; the ACP core's
  `session/request_permission` handling for grok/gemini-family; `local-computer` approval scope.
- **Error classification / fallback parity** so quota/rate/subscription failures fail over to the
  saved chain (see `server/model-fallback.ts` + WIP quota-cooldown registry on this branch).

---

## 4. What IS wired today (the good parts)

- `DshAgentDriver` is registered (`server/drivers/builtIn.ts:23,31`) and a `dsh` instance ships in
  the default fleet (`server/config.ts:461`) and product-fleet additions (`:486`).
- It rides `createAcpDriver` (`acp/core.ts`), so structurally it inherits: stdio JSON-RPC lifecycle,
  streaming (`agent_message_chunk`/`agent_thought_chunk`), tool items, the interactive permission
  broker (`session/request_permission`), MCP-server construction for agents/composio/computer/
  local-computer, `session/load` resume plumbing, and interrupt/stop/dispose.
- ACPI-adjacent product wiring exists: `ProviderIcons.tsx` maps `dshAgent` to an icon; UI copy
  points users to "DeepSeek Harness (`dsh`)" for full tool support; the env allowlist already names
  the DSH credential set (`DEEPSEEK_API_KEY`, `DSH_HOME`, `DSH_RUNTIME_ROOT`, `DSH_PERMISSION_MODE` —
  WIP in the working tree); `env-path.ts` augments PATH with `~/apps/dsh-runtime`; snapshot auth
  (WIP) accepts `~/.dsh/.credentials.yaml` or `DEEPSEEK_API_KEY`.
- Static model ids `deepseek-v4-flash` / `deepseek-v4-pro` match the real current DSH models
  (verified: this document was authored on a `deepseek-v4-pro` session) — the earlier audit D4
  ("retired chat/reasoner") is fixed.

---

## 5. Why it is not working (verified defects)

### 5.1 Blocking: every turn hard-fails the ACP auth gate — `acp/dsh.ts:68–69`

```ts
pickAuthMethod: () => null,   // unconditional — never inspects init.authMethods
authFailure: "fail",
```

`acp/core.ts:571–584`:
```ts
const methodId = support.pickAuthMethod(methods);   // null for DSH
if (!skipSubscriptionAuthForLocalInject(turn.model)) {
  if (methodId) { … } else if (support.authFailure === "fail") {
    throw new Error(support.loginNote);              // ← every turn, after initialize
  }
}
```

Because DSH's catalog models are cloud ids (not `host::` local injects), the gate always runs and
always throws `"DSH CLI auth missing — add ~/.dsh/.credentials.yaml"`, settling
`auth_required`/`setup` (`core.ts:698–706`). **This happens whether or not the user is
authenticated**, because the throw precedes any credential check (`isAuthenticated` is only used by
`snapshot()` and by `requireAuthenticationBeforeSpawn`, which DSH does not set).

No sibling pairs an unconditional `null` with `"fail"`:
- `acp/deepseek.ts:547–548`, `acp/kimi.ts:547–548`, `acp/droid.ts:246–247`,
  `acp/hermes.ts:429–430`, `acp/qwen.ts:107–108`, `acp/opencode-go.ts:372–373` → `() => null` +
  `"continue"` (ride the ambient login).
- `acp/grok.ts:253–254` → the only `"fail"`, but `pickAuthMethod` is **conditional** (`cached_token`
  iff advertised), a deliberate subscription gate.
- And the real DSH ACP bridge advertises `"authMethods": []` (see 5.3), so `"continue"` is the
  correct pairing, exactly as for deepseek/kimi.

### 5.2 Blocking: the spawn target does not speak ACP — `dsh` binary vs bridge

- `DshAgentDriver.defaultCli = "dsh"` (`acp/dsh.ts:43`) and `spawnArgs` produce `[]` (or only
  `--mcp …` flags) — no ACP subcommand, no model flag (`acp/dsh.ts:17–27`).
- Ground truth from `~/apps/dsh-runtime`: the pinned `@deepseek-ai/dsh` npm CLI
  (`node_modules/.bin/dsh → @deepseek-ai/dsh/lib/bin.js`) contains **zero** references to "acp", and
  the runtime README states: *"`dsh acp` is not a CLI command. Only `dsh web` is a hardcoded alias."*
  The npm binary's only subcommand is `web`/profile machinery; invoked with no useful args it will
  not speak JSON-RPC over stdio.
- The only working ACP server for DSH is the private bridge `~/apps/dsh-runtime/dsh-acp.py`
  (wrapper `dsh-acp.sh`), which execs `dsh --profile headless <prompt>` per prompt. It is
  machine-specific (hardcoded `/Users/jay/apps/dsh-runtime`, key lookup in the server user's home),
  and it ignores argv flags (`main()` only special-cases `--version`).
- On this machine `dsh` is not on PATH (`which -a dsh` → empty), and `~/apps/dsh-runtime` (added to
  the augmented PATH in `server/env-path.ts`) contains **no executable named `dsh`** — only
  `dsh.sh`, `dsh-acp.sh`, and `node_modules/.bin/dsh`. So even `snapshot()` reports
  "`dsh` CLI not found" unless a user hand-installs a `dsh` shim.
- Net: the driver cannot reach a working ACP server by default — and even the `--mcp` argv it emits
  is inert (the bridge ignores argv; see also audit finding D2 on `--mcp` duplication).

### 5.3 Blocking-ish: what the real bridge can and cannot do (if you point `cli` at it)

Read of `dsh-acp.py` (v1.3.0) — the actual protocol surface a working DSH ACP integration must talk to:

| Bridge behavior | Consequence for BotFleet |
|---|---|
| `initialize` advertises `"authMethods": []`, `promptCapabilities.image:false`, `loadSession:true` (lines 380–403) | `images:false` is correct; **auth must be `"continue"`**; no model list is advertised |
| `session/set_model` **not implemented**; unknown methods answer `{}` success (lines 404–405, 440–441) | Model-picker selection (`deepseek-v4-pro` vs flash) is **silently dropped**; the child runs the headless profile's pinned model (flash, low reasoning effort) — the exact "silently runs the wrong model" failure `core.ts:96–99` warns about. `configureSession`'s `catch{}` (`acp/dsh.ts:59–61`) hides this |
| `session/new` returns a random UUID; `session/load` echoes any id; `build_dsh_cmd` adds `--resume` **only** for ids starting `session-` (lines 227–232, 408–417) | Real DSH session dirs are `~/.dsh/sessions/<cwd>/session-…`; the fabricated UUIDs never map to them → **multi-turn resume is broken**; every prompt is a cold start, so fleet bots lose thread memory |
| `mcpServers` in `session/new`/`session/load` are **ignored**; the child is spawned with no MCP servers (lines 408–417, 227–232) | Agents/Composio/computer/phone MCP never mount, despite ACP core advertising `agentsMcp/computerMcp/composioMcp:true` for `dshAgent` (`acp/core.ts:739–741`) |
| `session/prompt` streams stdout as `agent_message_chunk` + heartbeat "thoughts"; **no tool events, no usage**; result is only `{stopReason:"endTurn"}` (lines 235–326) | No `item.started/completed` tool chips, no `thread.token-usage.updated`, no `turn.completed.usage` → telemetry/usage caps blind |
| `session/request_permission` is **never sent**; the headless profile forces `approval: never`, `sandbox: danger-full-access` (`~/.dsh/profiles/headless/cordis.patch.yml`) and disables questions/plan/subagents/web | DSH bots run unattended at full access — BotFleet's "bots ask before they act" and per-action cards cannot protect them, even in interactive mode; approvals in `acp/core.ts` can never fire |
| Bridge is machine-specific and phone-oriented (kills the child at a 900 s timeout, heartbeats for a phone UI) | Not distributable as the fleet engine as-is |

### 5.4 Functional gaps vs ACP siblings / first-tier (even with 5.1–5.3 fixed)

| Capability | `acp/dsh.ts` | Sibling norm / first-tier | Severity |
|---|---|---|---|
| `resolveModels` | stub returning the static 2 (line 42) — no CLI probe, no `mergeLocalInject` | dynamic: read CLI config + local injects (deepseek/kimi/grok/opencode/cursor/droid/hermes/qwen) | High |
| `resolveTurnModel` | identity (line 51) | `ensure*Inject*` alias writers so local `host::` picks work | High (for local-model support) |
| `configureSession` | `catch {}` swallow (59–61); doesn't confirm via `sessionModels` | throw on mismatch (grok/hermes/droid/cursor); confirm the pick | High |
| `spawnArgs` | `[]` or only `--mcp` | explicit ACP subcommand + `-m model` / effort argv | High (ties to 5.2) |
| `classifyError` | missing | opencode/cursor map to `ProviderErrorCode` (auth/quota/outage) | Medium |
| `isAuthenticated` | `homedir()` (70) ignores instance `HOME`/`DSH_HOME` | env-aware data roots (deepseek/kimi) | Medium |
| `install.command` / `signInCommand` | only `docsUrl` (47–49) | all install-bearing siblings have platform commands + sign-in | Medium (setup UX) |
| `applyTurnEnv` | missing | deepseek/kimi/droid overlay per-turn inject env | Medium |
| `effortLevels` | missing | only grok sets it | Low (unless DSH exposes effort) |
| `transformEnv` | dead no-op (64) | siblings strip foreign keys | Low |
| `access` | omitted → defaults `"subscription"` | BYOK-ish harnesses use `"custom"` (hermes/qwen) | Low |
| `generateText`/`reviewPermission` | not provided by ACP core | claude/antigravity/grok implement | Low–Medium (auto-review & some titles) |

---

## 6. Product-consistency issues that amplify the gap

1. **The picker sells a broken engine.** `src/components/ModelPicker.tsx:340–344` and
   `src/components/EnginesSettings.tsx:294` tell Minimax/limited users: *"For full tool support, use
   the Pi Engine's OpenAI compat, or the DeepSeek Harness (`dsh`)"*. Today a `dsh` bot cannot finish
   a single turn (5.1), so that guidance sends users to the least-working engine.
2. **Wrong DeepSeek ships by default.** The default fleet includes `dsh` but not the DeepSeek Code
   CLI (`deepseekAgent`) whose ACP driver is the mature one (dynamic catalog, install commands,
   local-inject, `"continue"` auth). Either DSH must reach sibling parity, or the default-fleet entry
   should be reconsidered until it does.
3. **README/claims drift.** `README.md` advertises "DeepSeek V3 and R1 join Claude, Codex, and
   Cursor via a native ACP driver plus the dsh bot" — neither the retired V3/R1 ids (audit D4) nor a
   working dsh path currently match reality.
4. **Headless-profile coupling.** The only working ACP backend drives `dsh --profile headless`,
   which is tuned for a *phone* agent (tools disabled, approvals never). A desktop BotFleet bot needs
   a different profile posture — or the fleet path must mount a profile that keeps approvals.

---

## 7. What "first-tier" specifically means for the fallback/parity work in flight

This branch (`ag/dsh-antigravity-fallback-parity-terminology`) is building exactly the substrate DSH
needs: text-level quota classification, `parseQuotaResetTime`, a quota-cooldown registry
(`server/model-fallback.ts` WIP), and DSH credential env + `DEEPSEEK_API_KEY` detection
(`acp/dsh.ts` WIP). Because the fallback engine is driver-agnostic and event/text driven
(`server/model-fallback.ts`, `server/index.ts` bus subscriber), DSH will participate **once its
turns can actually emit events**. Nothing in the fallback engine is DSH-specific today — but also
nothing compensates for DSH emitting `auth_required` on every turn (which the engine will dutifully
read as a setup problem, not a quota, so it will *not* even fail over to the saved chain — it will
stop and ask the user to add credentials they already have).

Two parity specifics worth adding while this branch is open:
- Give `acp/dsh.ts` a `classifyError` mapping the bridge/child's real failure shapes
  (`invalid_credentials` from a 401 at the model API, upstream outage, quota) so DSH failures land
  in the same buckets as claude/codex and the cooldown registry can record them.
- Once a turn can run, the missing `thread.token-usage.updated` / `usage` on completion (5.3) means
  usage caps/session limits that other engines honor will not apply to DSH bots.

---

## 8. Recommended roadmap

### Phase 0 — Unblock (make a DSH turn able to complete) · small, surgical
1. `acp/dsh.ts`: change `authFailure: "fail"` → `"continue"` (matches `acp/deepseek.ts:548`,
   `acp/kimi.ts:548`; the real bridge advertises no auth methods). *(Unblocks 5.1.)*
2. Decide and encode the real spawn target (5.2):
   - **Preferred:** upstream `dsh` gains a first-class `dsh acp` (native ACP server) and BotFleet's
     `defaultCli` stays `"dsh"` with a proper `spawnArgs` (`acp` subcommand, `-m model`).
   - **Interim:** point the driver at a bundled/installed bridge and make `spawnArgs`/`install`
     reflect it; remove the inert `--mcp` argv (audit D2) and rely on the ACP `mcpServers` path the
     bridge *will* learn, or wire argv the way the bridge actually parses.
   - Until a working target ships, prefer showing the instance as "setup required" over advertising a
     functional engine (5.2/6.1).
3. `acp/dsh.ts`: make `configureSession` honest — if `session/set_model` is unavailable, either fail
   the turn (throw, like grok/hermes/droid/cursor) when the requested model differs from the
   advertised default, or surface it; never swallow (5.3).

### Phase 1 — Sibling parity (match `acp/deepseek.ts` / `acp/kimi.ts`) · one file
4. `resolveModels`: probe the DSH runtime for its real model list (and read `~/.dsh/settings*.yaml`),
   keep the static v4 defaults as fallback, and `mergeLocalInject` so local `host::` models appear.
5. `resolveTurnModel` + `applyTurnEnv`: write the local-inject alias/env (mirror
   `ensureDeepSeekInjectAlias`/`applyDeepSeekLocalModelEnv`) so inject models survive the auth gate
   *and* reach the child.
6. `install`: add per-platform `install.command` + `signInCommand` (how does a user get the bridge /
   official binary and authenticate — likely "run `dsh` once / paste `DEEPSEEK_API_KEY`"), keep
   `docsUrl`.
7. `isAuthenticated`: honor `DSH_HOME`/`HOME` env, not `homedir()`; align with `~/.dsh/.credentials.yaml`
   parsing rules the bridge uses.
8. `classifyError`: map bridge/child errors to `ProviderErrorCode` (auth, quota, outage).
9. `transformEnv`: strip keys that would flip billing (a leaked DeepSeek **platform** key must not
   override the harness's own credential path) while keeping the allowlisted credential env.
10. `access`/label hygiene: decide `"subscription"` vs `"custom"`, and disambiguate the picker
    ("DeepSeek Harness" vs "DeepSeek Code" vs "DeepSeek API") with distinct labels/icons/copy.

### Phase 2 — First-tier equivalence (the fleet experience)
11. **Resume/continuity:** the ACP `session/load` path must hand the child a real resumable session
    id (`~/.dsh/sessions/<cwd>/session-*`) so thread memory survives across turns; until then every
    DSH bot is amnesiac (5.3).
12. **Model fidelity:** make the effective model observable — report the model the child actually
    runs in `session.started`, confirm after `session/set_model` (or set it via profile/env), and
    never silently run the profile default when the user picked another model.
13. **MCP tools for real:** get the bridge (or native `dsh acp`) to mount `session/new.mcpServers`;
    then the existing `acp/core.ts` machinery (agents/composio/computer/local-computer) lights up and
    the capability flags stop over-promising. Gate flags off until they can fire.
14. **Usage + tool telemetry:** bridge/native path should report `usage` (input/output) and tool
    lifecycle so chips, usage caps, and cost bookkeeping match claude/codex.
15. **Approval posture for desktop bots:** the bridge's phone-tuned headless profile (approval never,
    full access, tools disabled) must not be the fleet default. Give BotFleet bots a profile whose
    sandbox/approval posture matches their configured mode (interactive → asks; full-auto → bypass),
    so the permission broker and `local-computer` scope apply like other engines.
16. **generateText/reviewPermission:** add cheap one-shot text (and, where the harness can, isolated
    review) so DSH bots get titles/summaries and the auto-review path like claude/antigravity.

### Phase 3 — Productization
17. Fix the picker/settings copy that routes users to a broken engine (6.1) and the README claim
    (6.3); add `dshAgent` to the engine setup/onboarding surface once `install` exists.
18. Tests: extend `acp/dsh.test.ts` to (a) lock `authFailure`/`pickAuthMethod` consistency,
    (b) cover the inject rewrite, (c) cover the real bridge protocol shape (authMethods empty,
    set_model unknown-method reply, uuid sessions) so the config can't silently regress to
    "non-working" a third time (git history: removed once already as non-working).

---

## 9. Concrete file-by-file change list

| File | Change | Priority |
|---|---|---|
| `server/drivers/acp/dsh.ts:69` | `authFailure: "fail"` → `"continue"` (with a comment citing `authMethods: []` on the DSH ACP server) | P0 |
| `server/drivers/acp/dsh.ts:17–27` | Rework `spawnArgs` to the real working target (ACP subcommand/bridge); drop inert `--mcp` argv or make it match what the target parses | P0 |
| `server/drivers/acp/dsh.ts:55–62` | `configureSession`: throw/confirm on `session/set_model` failure or unsupported model; remove blind `catch{}` | P0 |
| `server/drivers/acp/dsh.ts:42` | `resolveModels`: probe DSH runtime catalog + `mergeLocalInject`, static fallback | P1 |
| `server/drivers/acp/dsh.ts:51` + new | `resolveTurnModel`/`applyTurnEnv` for `host::` injects | P1 |
| `server/drivers/acp/dsh.ts:47–49` | Add `install.command` (per-platform) + `signInCommand` | P1 |
| `server/drivers/acp/dsh.ts:70` | `isAuthenticated`: honor `DSH_HOME`/`HOME`/`USERPROFILE` | P1 |
| `server/drivers/acp/dsh.ts` | Add `classifyError`; make `transformEnv` real (billing-key hygiene) | P1 |
| `server/drivers/acp/dsh.ts:37–75` | `access`, labels, comments consistent with sibling style | P1 |
| `server/env-path.ts` (already touched on this branch) | Keep `~/apps/dsh-runtime` only if a real `dsh`/bridge executable can live there; else remove | P2 |
| `server/config.ts:461,486` | Reconsider `dsh` default-fleet presence until a turn can complete; or keep + Phase-0 fix in the same release | P1 |
| `src/components/ModelPicker.tsx:340–344`, `src/components/EnginesSettings.tsx:294` | Remove/adjust "use the DeepSeek Harness (`dsh`)" guidance until it works | P1 |
| `README.md` "Native DeepSeek driver" bullet | Align with shipped reality (engine + ids) | P2 |
| `server/drivers/acp/dsh.test.ts` | Lock auth combination, spawn args, inject rewrite, bridge-protocol shape | P1 |
| DSH side (`~/apps/dsh-runtime`, upstream `@deepseek-ai/dsh`) | Native `dsh acp`; or evolve `dsh-acp.py` into a maintainable, distributable server (env-driven paths, `mcpServers`, model setting, `--resume` for real session ids, usage/tool events, desktop profile) | P0–P2 |

---

## 10. Bottom line

DSH is currently **non-functional** in BotFleet — not merely under-featured — because of the
`authFailure: "fail"` + `pickAuthMethod: () => null` pair (5.1) and because the default spawn target
isn't an ACP server at all (5.2). Its inherited ACP core is the right foundation, and the sibling
drivers (especially `acp/deepseek.ts` and `acp/kimi.ts`, which are nearly identical in shape) prove
the parity target is a single-file job. The shortest path to "first-tier equivalent" is: fix the
auth pair and spawn target (P0), then port the deepseek/kimi support-object features over (P1), then
close the bridge's protocol gaps for resume, model fidelity, MCP, usage, and approval posture (P2).
Until a real turn can complete, the app should stop pointing users at `dsh` and shipping it as a
default engine — the git history already shows this driver removed once as "non-working".

---

*Evidence anchors: `server/drivers/acp/core.ts:564–584,698–706,739–744` · `server/drivers/acp/dsh.ts`
(all) · `server/drivers/acp/deepseek.ts:499–554` · `server/drivers/acp/kimi.ts:499–554` ·
`server/drivers/acp/grok.ts:184–263` · `server/drivers/builtIn.ts:25–45` · `server/config.ts:459–500` ·
`server/drivers/antigravity.ts` · `~/apps/dsh-runtime/dsh-acp.py:380–448` ·
`~/apps/dsh-runtime/README.md` · `~/apps/dsh-runtime/.dsh profiles headless patch` ·
`docs/audits/2026-08-31-full-stack-audit.md` (D1–D4) · git: `e270781`, `fe2605a`, `d70325c`.*

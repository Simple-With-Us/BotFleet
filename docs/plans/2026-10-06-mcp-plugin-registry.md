# MCP And Plugin Registry

Design for letting BotFleet add third-party MCP servers from a list, and plugins
from a supported list.  Owner need, 2026-10-06.

Board `f3ca73ca`.  Seat `MINIMAX`.  Branch `minimax/mcp-plugin-registry`.
Worktree `~/apps/botfleet-minimax-mcp-registry`.

## The Gap, In One Paragraph

Today the `mcpServers` array mounted into a bot turn is assembled in code from
BotFleet-owned integrations only: Composio, the agents proxy, computer mounts,
the phone proxy, Qdrant.  `acpMcpServers` in `server/drivers/acp/core.ts:89`
builds it for every ACP engine, and `server/drivers/claude.ts:1129` builds the
Claude twin before appending `--mcp-config` and `--strict-mcp-config`.  That
strict flag is deliberate: the 2026-09-11 provider-isolation rollout made it
impossible for a bot to reach the owner's global `~/.claude.json` servers, and
that isolation is a feature we protect rather than route around.  The
consequence is that there is no seam for an owner-managed row: nothing in the
registry, the panel, or the store.  The Cherry Studio parity audit records the
same gap as **Missing** at `docs/audits/2026-09-30-cherry-studio-and-upstream-openmausbot-review.md:96`,
with two Apache ports already identified upstream — `server/mcp-registry.ts`
(#697) and `src/components/McpServersPanel.tsx` (#956).

Note the asymmetry that makes this worth building rather than a curiosity.
BotFleet is already an excellent MCP **server**: `docs/mcp-server.md` ships 24
tools over stdio for other agents to drive bots, channels, approvals, routines,
and webhooks.  It is not yet an MCP **client** for anything it did not write.

## Non-Goals

- **No hardcoded vendor integration.**  Groken, and anything like it, arrives as
  an owner-managed row, never as a compiled-in dependency.  A shipped row would
  demand `uv`, Python 3.11, and a partner desktop app on every host, while
  BotFleet ships macOS, Windows, Linux, and containers.
- **No remote catalog.**  A catalog fetched from the network is a supply-chain
  channel with a UI on top.  Curated rows live in-repo, reviewed, version
  pinned, and never auto-update.  A signed remote catalog stays a non-goal
  until someone asks for it and we design the signature story first.
- **No change to the approval model.**  A row may add tools; it does not grant
  itself permission.  Approval cards keep deciding what runs.
- **No rework of the turn loop.**  This is a registry plus mount points.  It is
  deliberately not a provider-abstraction rewrite; see
  `docs/plans/2026-10-06-mcp-plugin-registry.md` § "Why Not The AI SDK" for the
  separate call on that.

## What We Accept

Grounded in open protocols rather than invented ones.

**Transports** are the Model Context Protocol's own three: stdio, Streamable
HTTP, and legacy SSE.  We add no transport of our own and no proxy dialect.

**Import shape** is the `{"mcpServers": { … }}` JSON that Claude Desktop,
Cursor, and `mcp.json` already use.  We accept it because it is the ecosystem
standard and asking the owner to hand-write our schema would be worse.  We
import it under the rules below; we do not adopt its trust assumptions.

## The Row

```ts
/** A value that must never be stored literally in the registry file. */
export type SecretRef = { infisical: string };

export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; cwd?: string;
      env: Record<string, SecretRef> }
  | { kind: "http"; url: string; headers: Record<string, SecretRef>;
      auth?: { kind: "oauth" } }
  | { kind: "sse"; url: string; headers: Record<string, SecretRef>;
      auth?: { kind: "oauth" };

export type TrustTier = "owner" | "curated";

export interface McpServerRow {
  id: string;              // stable slug, e.g. "groken"
  label: string;           // Title Case, shown in the panel
  transport: McpTransport;
  trust: TrustTier;
  enabled: boolean;        // false on import, always
  bots: string[];          // per-bot Access list; empty means nobody
  allowedTools?: string[]; // undefined means the server's whole surface
  version?: string;        // curated rows only, pinned
  catalog?: {              // curated rows only
    homepage: string;
    reviewedAt: string;
    reviewedBy: string;
    notes: string;
  };
  createdAt: string;
  updatedAt: string;
}
```

## The Rules, Each With A Reason

1. **An import lands disabled.**  A stdio row is an arbitrary command from a
   pasted string.  The panel previews the exact command line before first run
   and the owner turns it on deliberately.  Cherry Studio's `mcpInstall` does
   the same thing; upstream port item `cherry-mcp-tools-plugins-4`.
2. **No literal secrets, anywhere.**  Env and header values are `SecretRef`s
   resolved from the already-resolved in-memory `cfg` at mount time.  Never a
   `process.env` read for a vaulted value — the 2026-10-03 Infisical directive
   makes that a hard error, and the registry follows `server/secret-map.ts` and
   `server/knob-map.ts` discipline with one row per credential.
3. **Global config stays invisible.**  `--strict-mcp-config` does not go away.
   The mounted array is exactly BotFleet's own servers plus the rows granted to
   that one bot.  If isolation and convenience ever conflict, isolation wins.
4. **Helpers get no rows.**  A helper process gets an empty MCP list, same as
   today.
5. **Per-row tool allowlist, hashed tool ids.**  `allowedTools` narrows a row's
   surface.  Tool ids hash the row id plus a config hash, so editing a row's
   config does not orphan an in-flight turn or silently change history.
6. **Lazy connect keyed by config hash.**  One connect per changed row per turn.
   A Streamable HTTP server that answers 405 to the POST negotiates down to SSE
   once, then remembers.
7. **OAuth is PKCE, and tokens go to Infisical.**  Where a server advertises
   dynamic client registration we use it.  The loopback callback starts before
   the connect attempt and times out in five minutes.  Token material is
   written to the vault, not to a file beside the config.  Explicitly: do not
   copy Cherry Studio's plain-JSON token file — upstream port item
   `cherry-mcp-tools-plugins-8` calls that out, and the audit flags it too.
8. **Two trust tiers, shown honestly.**  A `curated` row was read by a seat
   before shipping and carries a pinned version, a known-tool manifest, and a
   Test button that runs `tools/list` and shows the diff against that manifest.
   An `owner` row is the owner's own risk and the panel says so in words.
9. **Cleartext is refused off loopback.**  A remote `http` row without auth and
   without TLS is not mountable.  `docs/mcp-server.md` already sets this
   precedent for the outbound direction; the inbound direction matches it.

## Where The Array Is Built

| Engine | Mount point | Wave 1? |
| --- | --- | --- |
| Claude | `server/drivers/claude.ts:1129` — append rows to `mcpServers` and `allowed` | yes |
| ACP family (Codex, Grok, DSH, Hermes) | `acpMcpServers`, `server/drivers/acp/core.ts:89` | yes |
| Antigravity, Pi | their existing mcpServers builders | yes |
| HTTP rows on any engine | a local stdio shim, mirroring `server/container-mcp.ts` and `server/mcp-bridge.ts` | wave 2 |
| BotFleet-native tool loop (MiniMax, openai-compat, native) | needs a real MCP **client** in `buildTurnTools` | wave 3 |

That last row is the honest cost centre.  Engines that take an MCP array get
rows almost for free.  BotFleet's own HTTP tool-loop engines do not: BotFleet
has to speak `tools/list` and `tools/call` itself and fold the results into the
turn tool host.  That is the difference between a config feature and a product
feature, and it is why Wave 3 is priced separately.

For container and VPS bots, prefer HTTP rows.  The managed image is a thin
computer-use desktop with no developer CLIs installed, so a stdio row needs its
binary present in the image before it can mean anything.

## What "Plugin" Means Here

Grok Bot calls its backend tool servers plugins, with credentials held on their
side.  For BotFleet a plugin is a curated MCP row plus a policy: reviewed
in-repo, version pinned, with a known-tool manifest, an owner-facing
description, and a health check.  The panel labels the tier on every row.

- **Catalog plugin** — shipped in-repo, reviewed, pinned, no auto-update.
- **Owner plugin** — anything pasted in, labelled as unreviewed.

No curated row ships that a seat has not read.  That is the whole policy.

## The Catalog File

In-repo, one entry per plugin, the row schema plus the `catalog` block.  Shipped
with the app, read-only in the UI except enable/disable and per-bot grants.
Editing it is a code review like everything else.

## Waves

- **Wave 1** — registry, panel, stdio transport, import-stored-inactive with
  command preview, Test button, per-bot Access list.  Engines that take an MCP
  array today.
- **Wave 2** — Streamable HTTP and SSE, OAuth via Infisical, hashed tool ids,
  tool allowlist enforcement, local stdio shim for remote rows.
- **Wave 3** — BotFleet-native MCP client so MiniMax, openai-compat, and native
  bots receive rows too.
- **Wave 4** — curated catalog, health and drift checks, and the first real row.

## Groken As The First Real Row

Assessed 2026-10-06, board `2e60c6f6`.  Verdict: reasonable, and a good test
case, at the **owner** tier rather than curated.

What is genuinely well built: OAuth PKCE with tokens in an owner-only file,
never sending local credentials through bot chat, human takeover for password,
2FA, CAPTCHA, and macOS prompts, `confirmed=true` on every mutating tool, a
typed adapter per risky operation instead of a generic method-and-args escape
hatch, no bot deletion command, and fail-closed detection on app drift.

What argues for caution: the HTTP and SSE transports carry **no authentication
at all**, so it is stdio-only for us and never a bound port; one account-wide
token file controls every bot on that Grok Bot account with no per-bot scoping,
which is exactly the isolation our 2026-09-11 rollout protects; all bots on an
account share one cloud computer, so a bot's browser sessions are the owner's
logged-in sessions; native execution is remote execution, not a sandbox; a
transport failure mid-mutation can leave an unknown outcome, so retries need the
same care ours already take; and the repository is private, single-author, one
star, with no independent audit of code that reverse-engineers a desktop app's
protocol — which also carries account risk, since an unofficial client is
outside the vendor's blessing.

None of that is disqualifying.  All of it is exactly what a row labelled
owner-managed, disabled by default, granted to named bots only, is for.

## Why Not The AI SDK

Owner asked whether a library like the Vercel AI SDK should be adopted to link
platforms to each other through Anthropic-format and OpenAI-format endpoints.
Answer: no, and not because the library is weak.

The reason those arguments fail is that BotFleet already has them.  It ships a
provider layer with per-provider drivers and catalogs under `server/drivers/`,
a model discovery path, a capability registry in
`src/lib/engine-capabilities.tsx`, model lineage, and a fallback walker in
`server/model-fallback.ts` that already does cost-aware failover with a capped
chain and a registry of rejected models.  Cost optimization, redundancy, and
failover are a first-class subsystem here, not a gap.

The AI SDK is also built for API endpoints, and BotFleet's most valuable engines
are not API endpoints.  Claude Code, Codex, the Grok CLI, and DSH are long-lived
CLI processes with their own sessions, resume semantics, tool loops, and
approval surfaces, reached over ACP.  No SDK abstraction covers that; BotFleet's
ACP layer is the part that does, and wrapping it in an API-shaped library would
mean rewriting the working core for a shape that fits the smaller half of the
fleet.

The specific DeepSeek opportunity is real and worth having, but it belongs in
the existing driver, not a new framework.  DeepSeek documents both dialects at
the vendor level: `https://api.deepseek.com` for OpenAI format and
`https://api.deepseek.com/anthropic` for Anthropic Messages
(`api-docs.deepseek.com`, "Your First API Call" and `guides/anthropic_api`).
Two hazards to respect when a row points there: an unrecognized model name is
silently mapped to DeepSeek's own default tier rather than erroring, and image,
document, and MCP tool blocks are not supported on the Anthropic endpoint.
Silent remapping would make the displayed model disagree with the served model,
which is the exact class of lie this codebase keeps fixing.  So: a
`deepseekApi` driver on the existing openai-compat shape, with an explicit model
allowlist and no pass-through of vendor aliases.

## What Could Go Wrong

- **A granted row is arbitrary code running with that bot's grants.**  Per-bot
  Access plus the tool allowlist are the only real controls; the panel must show
  both per row.
- **A dead server looks like a dead model.**  The health row has to distinguish
  "server unreachable" from "provider failed" or the fallback walk will chase a
  phantom quota problem.
- **Config edits changing tool ids** would break in-flight turns, which is why
  ids hash the config rather than the row.
- **A wide allowlist is a standing risk.**  Default a new row to no bots and no
  tools, and make widening it a deliberate act.

## Verification

Every wave names its recipe before it starts.  Fixtures use temporary data
directories and free ports; nothing here touches the harness on 8799 or live
user data.  Wave 1 in particular must prove, in an isolated fixture, that a
disabled row mounts nothing, that an enabled row granted to bot A does not
appear for bot B, that a helper receives an empty list, and that the owner's
global Claude config still cannot leak in under `--strict-mcp-config`.
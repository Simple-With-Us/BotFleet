# Plugins Show, Bots Cannot Extend: The Extension Surface Has No Door For Behavior

Seat: Echo.  Lens: adapters, plugins and MCP.  Evidence at origin/main `4e296b8c`, read by code, nothing run live.  Not covered by R1-R7, which stay on the overview and settings.

## Verdict

BotFleet has three extension surfaces and they do not meet.  Plugins add dashboard cards.  The MCP server lets an outside client drive the fleet.  Engines are compiled in.  A person can change what the fleet shows, and a client can change what the fleet does, but nobody can add what a bot can do without a pull request.

## What Each Surface Can Do

**Plugins are read-only by design.**  The capability allowlist has three entries: `read.bots`, `read.status`, `read.config` (`shared/plugin-manifest.ts:53-60`).  The manifest comment says adding one is a breaking change.  Plugins contribute cards in three layouts, `stat-grid`, `key-value`, `list` (`:63`), plus slash commands (`:129`).  They run in a child process with a Node permission grant (`server/plugin-loader.ts:245,436`).  The design doc names its own gaps as open owner questions: outbound network from the sandbox, a UI ceiling, and distribution signing (`docs/plugins/DESIGN.md:441`).  I found no later document that answers them (grep of `docs/`; not exhaustive).

**MCP is a control plane, not a tool source.**  The server exposes 26 tools (`scripts/mcp-server.ts:166-538`), all about steering bots, channels, tasks, approvals, routines and webhooks.  Its own doc says it cannot remember "always allow", delete data or touch credentials (`docs/mcp-server.md:18-20`).  That is a sound boundary.  It means the outside-in path is good and the inside-out path (a bot using a tool someone installed) goes elsewhere: `server/composio.ts` (1,104 lines) for connected apps and per-driver bridges such as `server/drivers/pi-mcp-extension.ts`.  Whether a person can attach an arbitrary MCP server to one bot from the UI: unverified.

**Engines are code.**  `DriverKind` is a bare `string` (`server/contracts.ts:14`), so the type invites extension, but each engine is a file in `server/drivers/` or a shim in `server/drivers/acp/` (15 non-test files there, 24 non-test files in `server/drivers/` itself).  The capability matrix is one registry row per engine (`src/lib/engine-capabilities.tsx:1-5`).  That registry is a good seam.  It is not user-writable.

## Positions

1. **Do not widen plugins yet.**  A plugin that can act inherits the egress problem the design doc leaves open.  Until the owner decides sandbox egress, read-only is the right ceiling.
2. **Give plugins one more read, the attention index.**  The attention rollup (`src/state/attention-index.ts:277`) is what every R-paper wants on screen.  A `read.attention` capability would let a plugin build the Needs You card the panel is asking for without touching the main bundle.  This is the cheapest test of the plugin system on a real need.
3. **Give MCP an attention read.**  Approvals are listable (`mcp-server.ts:458`) but failed runs and unread threads are not.  An outside client cannot answer "what needs me" in one call, which is the same gap R2 finds in the UI.
4. **Document one path for a new tool.**  Today the answer to "how do I give a bot a new tool" is spread across Composio, per-driver bridges and skills.  A single page saying which to use when is worth more than a new mechanism.

## Q6 Items In This Lens

- The MCP doc and tool names say "channels" (`mcp-server.ts:253-340`), while the app's word for the same object is set by terminology.  A client sees one word and the user another.  Unverified how many users see this.
- Plugin cards and commands have no entry in the command palette (`grep plugin src/components/CommandPalette.tsx`: no match).  A plugin command is reachable only through its own manager view (`PluginsManagerView.tsx`).

## Ranked Recommendations

1. **S:** Write the one-page "how a bot gets a new tool" guide, and decide the sandbox egress question the design doc has held open since it was written.
2. **M:** Add `read.attention` to plugins and an attention tool to MCP, both over the same selector.
3. **L:** Let a bot load a plugin-supplied tool, after the egress decision, with the capability allowlist as the consent surface.

## The Owner's Decision

Should a plugin ever be able to act, or is "plugins show, the app acts" permanent?  The answer decides whether adapters stay a developer concern or become a product feature.

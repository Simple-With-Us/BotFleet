// The one table of engine job capabilities, shared by both sides.
//
// `server/jobs/engine-lanes.test.ts` pins every engine's lane against it and
// asserts it covers every entry in `BUILT_IN_DRIVERS`, so a new engine cannot
// land without stating its reach — the same discipline
// `server/computer-capability.fixtures.ts` keeps for computers.  It drifted
// once: the client offered "This computer" to an engine the server never
// mounted it for.  A false `emulated` here would be the jobs version of that.

import type { JobLaneFlags } from "./engine-lanes.ts";

export interface JobEngineFixture {
  /** The engine as a person sees it named in the picker. */
  displayName: string;
  driverKind: string;
  /** The three flags the lane derivation reads, transcribed from the driver
   *  sources.  Anything absent is absent in the driver too. */
  capabilities: JobLaneFlags;
  /** The lane this engine lands on with the default settings and a bot that
   *  holds This Computer.  Written out so a change to any of the three flags
   *  has to be a deliberate edit here as well. */
  lane: "http" | "mcp" | "none";
  /** Why that lane, in one clause.  The cases worth reading twice. */
  because: string;
}

export const JOB_ENGINE_FIXTURES: readonly JobEngineFixture[] = [
  // The harness runs the tool rounds and hands them plain definitions, so the
  // tools need no mount (jobs P1).
  { displayName: "Grok", driverKind: "grok", capabilities: { toolLoop: true, backgroundJobs: "emulated" }, lane: "http", because: "harness tool rounds" },
  { displayName: "MiniMax", driverKind: "minimax", capabilities: { toolLoop: true, backgroundJobs: "emulated" }, lane: "http", because: "harness tool rounds" },
  { displayName: "OpenAI-compatible", driverKind: "openai-compat", capabilities: { toolLoop: true, backgroundJobs: "emulated" }, lane: "http", because: "harness tool rounds" },

  // MCP-client engines.  The tools ride the `agents` server the driver already
  // mounts (jobs P2).
  { displayName: "Claude", driverKind: "claudeAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },
  { displayName: "Codex", driverKind: "codex", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },
  { displayName: "pi", driverKind: "piAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "pi-mcp-extension proxies the agents server" },
  { displayName: "DSH", driverKind: "dshAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server, through the Clutch spawn wrapper" },
  { displayName: "Grok CLI", driverKind: "grokAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },
  { displayName: "Kimi", driverKind: "kimiAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },
  { displayName: "mcode", driverKind: "mcodeAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },
  { displayName: "Muse Code", driverKind: "museAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server, forwarded through the muse-code-acp adapter" },
  { displayName: "Cursor", driverKind: "cursorAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },
  { displayName: "Droid", driverKind: "droidAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },
  { displayName: "opencode", driverKind: "opencodeGo", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },
  { displayName: "Qwen Code", driverKind: "qwenAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },
  { displayName: "Hermes", driverKind: "hermesAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },
  { displayName: "DeepSeek Agent", driverKind: "deepseekAgent", capabilities: { agentsMcp: true, backgroundJobs: "emulated" }, lane: "mcp", because: "agents MCP server" },

  // Gated, with the reason kept next to the claim so it is not a shrug.
  {
    displayName: "Antigravity",
    driverKind: "antigravityAgent",
    capabilities: { agentsMcp: true, backgroundJobs: "none" },
    lane: "none",
    because: "its global ~/.gemini mount cannot be cleaned on a crash path (P2 gate ii)",
  },
  {
    displayName: "boxAgent",
    driverKind: "boxAgent",
    capabilities: { backgroundJobs: "none" },
    lane: "none",
    because: "remote and opaque: no MCP, no host shell",
  },
  {
    displayName: "CLI wrapper",
    driverKind: "cli-wrapper",
    capabilities: { backgroundJobs: "none" },
    lane: "none",
    because: "generic CLI wrapper: unmounted tool loop, no MCP server",
  },
];

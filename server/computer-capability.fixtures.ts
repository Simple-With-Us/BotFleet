// The one table of engine computer capabilities, shared by both sides.
//
// `server/computer-capability.test.ts` pins the server's derivation against
// it and `src/lib/local-computer.test.ts` pins the picker against it, so the
// two can never again agree with their own fixtures and disagree with each
// other — which is exactly how the client came to offer "This computer" to
// an engine the server will not mount it for.
//
// Same dependency ban as `computer-capability.ts`: the client test imports
// this file, so it must stay importable without a harness.  In particular it
// must NOT import `drivers/builtIn.ts` — the coverage check that every
// built-in driver has a row here lives in the server test, which may.

import type { ComputerCapabilityFlags } from "./computer-capability.ts";

export interface EngineFixture {
  /** The engine as a person sees it named in the picker. */
  displayName: string;
  driverKind: string;
  capabilities: ComputerCapabilityFlags;
}

/** Every engine the default fleet ships, with the computer flags its driver
 *  actually declares.  Transcribed from the driver sources; the server test
 *  asserts this list covers every entry in `BUILT_IN_DRIVERS`, so a new
 *  driver cannot land without stating its reach here. */
export const ENGINE_FIXTURES: readonly EngineFixture[] = [
  // Harness tool-loop engines: the harness runs the rounds and hands them
  // tool definitions, so they reach the host and no mounted computer.
  { displayName: "Grok", driverKind: "grok", capabilities: { toolLoop: true, localComputerMcp: true } },
  { displayName: "MiniMax", driverKind: "minimax", capabilities: { toolLoop: true, localComputerMcp: true } },
  {
    displayName: "OpenAI-compatible",
    driverKind: "openai-compat",
    capabilities: { toolLoop: true, localComputerMcp: true },
  },

  // MCP-client engines: the harness mounts a computer beside the agent.
  { displayName: "Claude", driverKind: "claudeAgent", capabilities: { computerMcp: true, localComputerMcp: true } },
  { displayName: "Codex", driverKind: "codex", capabilities: { computerMcp: true, localComputerMcp: true } },
  {
    displayName: "Antigravity",
    driverKind: "antigravityAgent",
    capabilities: { computerMcp: true, localComputerMcp: true },
  },
  { displayName: "pi", driverKind: "piAgent", capabilities: { computerMcp: true, localComputerMcp: true } },
  // Every ACP engine answers all of its MCP flags together off one question
  // — does this harness mount what `session/new` hands it? — see
  // `drivers/acp/core.ts`.  None of the shipped supports turns it off.
  { displayName: "Grok ACP", driverKind: "grokAgent", capabilities: { computerMcp: true, localComputerMcp: true } },
  {
    displayName: "DeepSeek",
    driverKind: "deepseekAgent",
    capabilities: { computerMcp: true, localComputerMcp: true },
  },
  { displayName: "DSH", driverKind: "dshAgent", capabilities: { computerMcp: true, localComputerMcp: true } },
  { displayName: "Kimi", driverKind: "kimiAgent", capabilities: { computerMcp: true, localComputerMcp: true } },
  { displayName: "Droid", driverKind: "droidAgent", capabilities: { computerMcp: true, localComputerMcp: true } },
  { displayName: "Cursor", driverKind: "cursorAgent", capabilities: { computerMcp: true, localComputerMcp: true } },
  { displayName: "OpenCode", driverKind: "opencodeGo", capabilities: { computerMcp: true, localComputerMcp: true } },
  { displayName: "Qwen", driverKind: "qwenAgent", capabilities: { computerMcp: true, localComputerMcp: true } },
  { displayName: "Hermes", driverKind: "hermesAgent", capabilities: { computerMcp: true, localComputerMcp: true } },
  { displayName: "MiniMax Code", driverKind: "mcodeAgent", capabilities: { computerMcp: true, localComputerMcp: true } },
  // Muse Code mounts MCP for the same reason every other ACP coding CLI does:
  // the core answers every MCP flag from `mcpServers !== false`, and this
  // driver does not opt out.
  { displayName: "Muse Code", driverKind: "museAgent", capabilities: { computerMcp: true, localComputerMcp: true } },

  // The remote agent.  Its driver declares no computer flag at all: the turn
  // runs on the box, so there is nothing to mount.
  { displayName: "ASCII.dev Box", driverKind: "boxAgent", capabilities: {} },

  // Generic CLI wrapper: spawns local processes without mounting a computer.
  { displayName: "Generic CLI Wrapper", driverKind: "cli-wrapper", capabilities: {} },
];

/** Cells that no shipped engine occupies but the derivation still has to
 *  answer — an ACP engine configured without MCP servers, and each transport
 *  with host control withheld.  They are kept apart from `ENGINE_FIXTURES`
 *  so the registry-coverage check stays about real engines. */
export const SYNTHETIC_FIXTURES: readonly EngineFixture[] = [
  { displayName: "ACP without MCP servers", driverKind: "someAcpAgent", capabilities: {} },
  {
    displayName: "MCP client without host control",
    driverKind: "someMcpAgent",
    capabilities: { computerMcp: true },
  },
  { displayName: "Tool loop without host control", driverKind: "someLoop", capabilities: { toolLoop: true } },
  // The box-native engine is asked again with host control declared, because
  // "runs somewhere else" has to beat a flag, not lose to it.
  {
    displayName: "ASCII.dev Box with host control declared",
    driverKind: "boxAgent",
    capabilities: { localComputerMcp: true },
  },
];

export const ALL_FIXTURES: readonly EngineFixture[] = [...ENGINE_FIXTURES, ...SYNTHETIC_FIXTURES];

/** Look a fixture up by the name the tests use, so a renamed row fails loudly
 *  instead of silently testing `undefined`. */
export function engineFixture(displayName: string): EngineFixture {
  const found = ALL_FIXTURES.find((fixture) => fixture.displayName === displayName);
  if (!found) throw new Error(`no engine fixture named ${displayName}`);
  return found;
}

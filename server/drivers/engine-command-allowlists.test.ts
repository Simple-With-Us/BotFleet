import { describe, expect, it } from "vitest";

import { buildBotCommands } from "../command-registry.ts";
import {
  ENGINE_COMMAND_ALLOWLIST_BY_DRIVER,
  GROK_AGENT_COMMANDS,
} from "./engine-command-allowlists.ts";
import { isDeniedEngineCommand, offeredEngineCommands } from "./engine-commands.ts";

const DRIVER_KINDS = [
  "claudeAgent",
  "grokAgent",
  "cursorAgent",
  "opencodeGo",
  "kimiAgent",
  "qwenAgent",
  "deepseekAgent",
  "droidAgent",
  "mcodeAgent",
  "dshAgent",
  "hermesAgent",
  "museAgent",
] as const;

describe("ENGINE_COMMAND_ALLOWLIST_BY_DRIVER", () => {
  it.each(DRIVER_KINDS)("keeps denied names out of %s", (driverKind) => {
    const entries = ENGINE_COMMAND_ALLOWLIST_BY_DRIVER[driverKind] ?? [];
    for (const entry of entries) {
      expect(isDeniedEngineCommand(entry.name), `${driverKind}:${entry.name}`).toBe(false);
      expect(entry.provenOn.cliVersion).toMatch(/\d+\.\d+/);
    }
  });

  it("offers Grok /compact when the agent announces it on 1.0.0", () => {
    const offered = offeredEngineCommands("grokAgent", ["compact", "model"], "1.0.0 (grok)");
    expect(offered.map((entry) => entry.name)).toEqual(["compact"]);
  });

  it("offers Cursor /compress when announced on the 1.0.0 line", () => {
    const offered = offeredEngineCommands("cursorAgent", ["compress", "config"], "1.0.0 (Cursor Agent)");
    expect(offered.map((entry) => entry.name)).toEqual(["compress"]);
  });

  it("offers Kimi built-ins on the verified 0.29.1 line", () => {
    const offered = offeredEngineCommands("kimiAgent", ["compact", "context"], "0.29.1");
    expect(offered.map((entry) => entry.name)).toEqual(["compact", "context"]);
  });

  it("builds the Claude desktop fixture shape when compact and context are announced", () => {
    const response = buildBotCommands({
      botId: "b-atlas",
      threadId: "t-7f2c",
      surface: "desktop",
      busy: false,
      engine: {
        instanceId: "claude",
        driverKind: "claudeAgent",
        displayName: "Claude",
        model: "claude-opus-5-5",
        modelLabel: "Opus 5.5",
        effort: "high",
        modelOptionCount: 3,
        effortLevels: ["low", "high"],
        supportsCommands: true,
        available: true,
        cliVersion: "2.1.287 (Claude Code)",
      },
      allowsMultipleThreads: false,
      hasSession: true,
      announced: ["compact", "context"],
    });
    const engine = response.groups.find((group) => group.id === "engine");
    expect(engine?.commands.map((command) => command.name)).toEqual(["compact", "context"]);
    expect(GROK_AGENT_COMMANDS[0]?.name).toBe("compact");
  });
});

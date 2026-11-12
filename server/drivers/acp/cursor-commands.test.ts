// Cursor Agent slash commands through the shared ACP core and fake CLI.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { CursorAgentDriver } from "./cursor.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

describe("Cursor slash commands (fake agent)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async () => {
    instance = await CursorAgentDriver.create({
      instanceId: "cursor-commands-test",
      displayName: "Cursor",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  const echoed = (): string =>
    recorder.events
      .filter((e) => e.type === "item.completed" && e.itemType === "assistant_text")
      .map((e) => (e.type === "item.completed" && e.itemType === "assistant_text" ? e.text : ""))
      .join("");

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    process.env.FAKE_ACP_MODE = "echo-gated";
  });

  afterEach(async () => {
    for (const name of ["FAKE_ACP_MODE", "FAKE_ACP_COMMANDS", "FAKE_ACP_COMMANDS_REPLAY"]) delete process.env[name];
    recorder?.stop();
    await instance?.dispose();
  });

  it("announces Cursor commands from available_commands_update", async () => {
    process.env.FAKE_ACP_COMMANDS = "compress,/summarize";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cursor-discover", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const events = recorder.events.filter((e) => e.type === "engine.commands");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      names: ["compress", "summarize"],
      origin: "acp-available-commands",
      provider: "cursorAgent",
    });
  });

  it("writes a command turn as the bare /compress line", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-cursor-command",
      text: "ignored",
      system: "You are Testy.",
      command: { name: "compress", args: "focus on tests" },
    });
    await recorder.until((e) => e.type === "turn.completed");
    expect(echoed()).toBe("echo: /compress focus on tests");
  });
});

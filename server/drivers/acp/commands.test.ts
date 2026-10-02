// Slash commands through the shared ACP core, against the scripted fake agent.
//
// An ACP agent announces its commands in an `available_commands_update` right
// after session/new or session/load, before the prompt goes out.  A command
// turn is written bare, and every other turn is shielded so a leading slash
// in what the model is sent cannot run as a command.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { SLASH_NEUTRALIZER } from "../engine-commands.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");

const COMMANDS_SUPPORT: AcpSupport = {
  driverKind: "commandsTest",
  displayName: "Commands Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: FAKE_CLI,
  nativeSource: "test.acp",
  loginNote: "never reached",
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
};
const CommandsDriver = createAcpDriver(COMMANDS_SUPPORT);

describe("ACP slash commands (fake agent)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async () => {
    instance = await CommandsDriver.create({
      instanceId: "acp-commands-test",
      displayName: "Commands Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);
  };

  /** the text of the agent's echo, which is the whole session/prompt it was sent */
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

  it("announces the agent's commands once, normalized, before the prompt and never as a transcript item", async () => {
    process.env.FAKE_ACP_COMMANDS = "compact,/Context,compact,my:plugin";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-acp-discover", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const events = recorder.events.filter((e) => e.type === "engine.commands");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      names: ["compact", "context"],
      origin: "acp-available-commands",
      provider: "commandsTest",
    });
    // announced ahead of the prompt, and it never became bot text
    const order = recorder.events.map((e) => e.type);
    expect(order.indexOf("engine.commands")).toBeLessThan(order.indexOf("content.delta"));
    expect(echoed()).not.toContain("compact");
  });

  it("still hears the announcement a resumed session sends while it replays history", async () => {
    process.env.FAKE_ACP_COMMANDS = "compact";
    process.env.FAKE_ACP_COMMANDS_REPLAY = "1";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-acp-replay", text: "hi", resumeCursor: "fake-acp-session" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "engine.commands")).toHaveLength(1);
  });

  it("says nothing when the agent announces no commands", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-acp-none", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(recorder.events.filter((e) => e.type === "engine.commands")).toEqual([]);
  });

  it("declares the capability that makes a command menu worth showing", async () => {
    await create();
    expect(instance.adapter.capabilities.engineCommands).toBe(true);
  });

  it("writes a command turn as the bare command, with no persona in front", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-acp-command",
      text: "ignored",
      system: "You are Testy.",
      command: { name: "compact", args: "focus on tests" },
    });
    await recorder.until((e) => e.type === "turn.completed");
    expect(echoed()).toBe("echo: /compact focus on tests");
  });

  it("shields a turn whose composed text would start with a slash", async () => {
    await create();
    // no persona, so the user's own text leads the prompt
    await instance.adapter.sendTurn({ threadId: "t-acp-shield", text: "/model gpt-x" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(echoed()).toBe(`echo: ${SLASH_NEUTRALIZER}/model gpt-x`);
  });

  it("leaves a persona-led turn exactly as before", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-acp-persona", text: "/not-a-command", system: "You are Testy." });
    await recorder.until((e) => e.type === "turn.completed");
    expect(echoed()).toBe("echo: You are Testy.\n\n/not-a-command");
  });
});

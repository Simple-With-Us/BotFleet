// The mcode thread-title marker goes through the real driver, so these tests
// pin the three things a unit test of the prefix alone cannot:  that only the
// turn which opens the native session carries it, that it lands in front of the
// budgeted prompt without changing what the budget trims, and that a turn with
// no recognizable bot is sent as it always was.  The fake ACP CLI echoes the
// prompt text it receives, which is what is read back here.
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { ACP_PROMPT_SECTION_OMITTED } from "./prompt-budget.ts";
import { McodeAgentDriver } from "./mcode.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const persona = "You are Plumber (display: Plumber), a bot in BotFleet.";

describe("mcode thread-title marker through the driver", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  beforeEach(() => {
    vi.stubEnv("OMB_DATA_DIR", mkdtempSync(join(tmpdir(), "acp-first-reply-")));
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    vi.stubEnv("FAKE_ACP_MODE", "echo-gated");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    recorder?.stop();
    await instance?.dispose();
  });

  const create = async (config: { promptBudgetBytes?: number } = {}) => {
    instance = await McodeAgentDriver.create({
      instanceId: "mcode-title-test",
      displayName: "MiniMax Code",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, ...config },
    });
    recorder = recordEvents(instance.adapter);
  };

  const echoes = (threadId: string): string[] =>
    recorder.events.flatMap((event) =>
      event.type === "item.completed" && event.itemType === "assistant_text" && event.threadId === threadId
        ? [event.text]
        : [],
    );

  it("marks the turn that opens a session, and only that one", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-title-new", text: "first", system: persona });
    await recorder.until((event) => event.type === "turn.completed" && event.threadId === "t-title-new");
    expect(echoes("t-title-new").join("")).toBe(`echo: [Plumber]\n\n${persona}\n\nfirst`);
  });

  it("does not mark a turn that resumes a saved session", async () => {
    await create();
    await instance.adapter.sendTurn({
      threadId: "t-title-resumed",
      text: "second",
      system: persona,
      resumeCursor: "fake-acp-session",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.threadId === "t-title-resumed");
    expect(echoes("t-title-resumed").join("")).toBe(`echo: ${persona}\n\nsecond`);
  });

  it("leaves a turn with no recognizable bot exactly as before", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-title-plain", text: "hi", system: "Be brief." });
    await recorder.until((event) => event.type === "turn.completed" && event.threadId === "t-title-plain");
    expect(echoes("t-title-plain").join("")).toBe("echo: Be brief.\n\nhi");
  });

  it("keeps trimming volatile sections when the marker is present", async () => {
    await create({ promptBudgetBytes: 512 });
    const stable = `${persona}\n`;
    const volOld = `VOLATILE-OLD ${"alpha ".repeat(400)}`;
    const volNew = "VOLATILE-NEW kept";
    await instance.adapter.sendTurn({
      threadId: "t-title-budget",
      text: "CURRENT",
      system: stable + volOld + volNew,
      systemSections: [
        { id: "persona", text: stable, volatile: false },
        { id: "memory", text: volOld, volatile: true },
        { id: "mentions", text: volNew, volatile: true },
      ],
    });
    await recorder.until((event) => event.type === "turn.completed" && event.threadId === "t-title-budget");
    const sent = echoes("t-title-budget").join("");
    expect(sent).toBe(`echo: [Plumber]\n\n${stable}${ACP_PROMPT_SECTION_OMITTED}${volNew}\n\nCURRENT`);
    expect(recorder.events.some((event) => event.type === "runtime.error" && event.threadId === "t-title-budget")).toBe(false);
  });
});

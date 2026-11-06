// `AcpSupport.promptPrefix` in the shared ACP core: it is applied after budgeting,
// its UTF-8 bytes come out of the budget, a command turn never gets one, and it is
// told whether the turn opened the native session.  The fake ACP CLI echoes the
// whole session/prompt text.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const MARKER = "[名前名前名前名前]\n\n"; // 8 characters, 24 bytes, plus 4 ASCII = 28 bytes
const seen: Array<{ newSession: boolean }> = [];
let prefixOn = true;

const SUPPORT: AcpSupport = {
  driverKind: "promptPrefixTest",
  displayName: "Prompt Prefix Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: FAKE_CLI,
  nativeSource: "test.acp",
  loginNote: "never reached",
  spawnArgs: () => [],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: () => true,
  promptPrefix: (_turn, context) => {
    seen.push(context);
    return prefixOn ? MARKER : undefined;
  },
};
const PrefixDriver = createAcpDriver(SUPPORT);

describe("ACP promptPrefix", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    vi.stubEnv("FAKE_ACP_MODE", "echo-gated");
    seen.length = 0;
    prefixOn = true;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    recorder?.stop();
    await instance?.dispose();
  });

  const create = async (promptBudgetBytes?: number) => {
    instance = await PrefixDriver.create({
      instanceId: "acp-prefix-test",
      displayName: "Prompt Prefix Test",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false, ...(promptBudgetBytes === undefined ? {} : { promptBudgetBytes }) },
    });
    recorder = recordEvents(instance.adapter);
  };
  const echoed = (threadId: string): string =>
    recorder.events
      .flatMap((e) => (e.type === "item.completed" && e.itemType === "assistant_text" && e.threadId === threadId ? [e.text] : []))
      .join("")
      .replace(/^echo: /, "");

  it("puts the prefix in front of the whole prompt and says the session is new", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-prefix-new", text: "hello" });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-new");
    expect(echoed("t-prefix-new")).toBe(`${MARKER}hello`);
    expect(seen).toEqual([{ newSession: true }]);
  });

  it("says the session is not new when the turn resumes a saved one", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-prefix-resume", text: "hello", resumeCursor: "fake-acp-session" });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-resume");
    expect(seen).toEqual([{ newSession: false }]);
  });

  it("never asks for a prefix on a command turn", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-prefix-cmd", text: "x", command: { name: "compact", args: "a" } });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-cmd");
    expect(echoed("t-prefix-cmd")).toBe("/compact a");
    expect(seen).toEqual([]);
  });

  it("counts the prefix's UTF-8 bytes against the hard ceiling, so a prompt can never be sent past it", async () => {
    // Budget 500 gives a hard ceiling of 1000 bytes.  This protected text is 989
    // bytes on its own (it has no trimmable section), under the ceiling without
    // the 28-byte multibyte prefix and 1017 bytes with it.  The prefix is
    // reserved out of the budget, so the turn is refused instead of sent over.
    await create(500);
    const persona = "S".repeat(980);
    prefixOn = false;
    await instance.adapter.sendTurn({ threadId: "t-prefix-control", text: "CURRENT", system: persona });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-control");
    expect(Buffer.byteLength(echoed("t-prefix-control"))).toBe(989);

    prefixOn = true;
    await instance.adapter.sendTurn({ threadId: "t-prefix-bytes", text: "CURRENT", system: persona });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-bytes");
    expect(Buffer.byteLength(echoed("t-prefix-bytes"))).toBeLessThanOrEqual(1000);
    expect(
      recorder.events.some((e) => e.type === "runtime.error" && e.threadId === "t-prefix-bytes"),
    ).toBe(true);
  });
});

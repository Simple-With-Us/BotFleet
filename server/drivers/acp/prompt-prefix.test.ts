// `AcpSupport.promptPrefix` in the shared ACP core: it is applied after budgeting,
// its UTF-8 bytes come out of the budget, a command turn never gets one, and it is
// told whether the turn opened the native session.  The fake ACP CLI echoes the
// whole session/prompt text.
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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
    return prefixOn && context.newSession ? MARKER : undefined;
  },
};
const PrefixDriver = createAcpDriver(SUPPORT);

describe("ACP promptPrefix", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  beforeEach(() => {
    vi.stubEnv("OMB_DATA_DIR", mkdtempSync(join(tmpdir(), "acp-first-reply-")));
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
      config: { cli: FAKE_CLI, fullAuto: false, promptBudgetBytes },
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

  const sessionIdOf = (threadId: string): string => {
    const started = recorder.events.find((e) => e.type === "session.started" && e.threadId === threadId);
    if (!started || started.type !== "session.started") throw new Error("no session.started");
    return String(started.sessionId);
  };

  it("asks again when the first prompt of a session failed after its cursor was saved", async () => {
    await create();
    // Turn 1 opens the session and its prompt fails, so the marker is not known
    // to have landed.  The cursor is already saved at that point.
    vi.stubEnv("FAKE_ACP_MODE", "fail-after-text");
    await instance.adapter.sendTurn({ threadId: "t-prefix-fail", text: "first" });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-fail");
    const cursor = sessionIdOf("t-prefix-fail");
    expect(seen).toEqual([{ newSession: true }]);

    // Turn 2 resumes that cursor.  It is a new message, not a replay of turn 1.
    vi.stubEnv("FAKE_ACP_MODE", "echo-gated");
    await instance.adapter.sendTurn({ threadId: "t-prefix-fail2", text: "second", resumeCursor: cursor });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-fail2");
    expect(seen).toEqual([{ newSession: true }, { newSession: true }]);
    expect(echoed("t-prefix-fail2")).toBe(`${MARKER}second`);
  });

  it("still owes the marker after a server restart that forgot everything in memory", async () => {
    await create();
    vi.stubEnv("FAKE_ACP_MODE", "fail-after-text");
    await instance.adapter.sendTurn({ threadId: "t-prefix-restart", text: "first" });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-restart");
    const cursor = sessionIdOf("t-prefix-restart");

    // A new driver instance shares nothing with the first except the disk.
    recorder.stop();
    await instance.dispose();
    seen.length = 0;
    vi.stubEnv("FAKE_ACP_MODE", "echo-gated");
    await create();
    await instance.adapter.sendTurn({ threadId: "t-prefix-restart2", text: "second", resumeCursor: cursor });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-restart2");
    expect(seen).toEqual([{ newSession: true }]);
    expect(echoed("t-prefix-restart2")).toBe(`${MARKER}second`);

    // Answered now, so a further resume is unmarked.
    await instance.adapter.sendTurn({ threadId: "t-prefix-restart3", text: "third", resumeCursor: cursor });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-restart3");
    expect(seen).toEqual([{ newSession: true }, { newSession: false }]);
    expect(echoed("t-prefix-restart3")).toBe("third");
  });

  it("does not ask again once the first prompt has been answered", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-prefix-ok", text: "first" });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-ok");
    const cursor = sessionIdOf("t-prefix-ok");
    await instance.adapter.sendTurn({ threadId: "t-prefix-ok2", text: "second", resumeCursor: cursor });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-prefix-ok2");
    expect(seen).toEqual([{ newSession: true }, { newSession: false }]);
    expect(echoed("t-prefix-ok2")).toBe("second");
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

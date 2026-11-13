// The native tee is the file people paste into bug reports, so the wiring
// that keeps credentials out of it is tested at the writer — redact.test.ts
// covers the masking function, this covers that appendNative actually calls it.
// (server/testing/setup.ts points HOME at a throwaway dir, so NATIVE_DIR is
// already isolated from the real fleet.)
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { ensureDirs, NATIVE_DIR } from "../config.ts";
import { LOG_TEE_MAX_STRING_CHARS } from "../redact.ts";
import { appendNative, flushNativeTee, nativeTeeStats } from "./native.ts";

beforeAll(() => ensureDirs());

describe("appendNative", () => {
  it("masks the tokens an ACP session/new hands the agent", async () => {
    appendNative("t-native", {
      dir: "out",
      source: "acp",
      msg: {
        method: "session/new",
        params: {
          mcpServers: [
            {
              name: "computer",
              env: [
                { name: "OGB_BOX_ID", value: "box-7" },
                { name: "OGB_BOX_TOKEN", value: "box_live_dontlogme" },
              ],
            },
          ],
        },
      },
    });

    await flushNativeTee();
    const log = readFileSync(join(NATIVE_DIR, "t-native.ndjson"), "utf8");
    expect(log).not.toContain("box_live_dontlogme");
    // the shape a debugger needs is still there: which server, which var
    expect(log).toContain("session/new");
    expect(log).toContain("OGB_BOX_TOKEN");
    expect(log).toContain("box-7");
  });

  it("writes the log private to the user", async () => {
    appendNative("t-mode", { dir: "in", source: "acp", msg: { hello: "world" } });
    await flushNativeTee();
    const mode = statSync(join(NATIVE_DIR, "t-mode.ndjson")).mode & 0o777;
    // Windows does not implement POSIX modes; everywhere else, owner-only
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("never throws, whatever it is handed", () => {
    expect(() => appendNative("t-bad", { dir: "in", source: "acp", msg: undefined })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => appendNative("t-cyclic", { dir: "in", source: "acp", msg: cyclic })).not.toThrow();
  });

  it("caps a 5 MB payload and never writes it on the caller's stack", async () => {
    const file = join(NATIVE_DIR, "t-huge.ndjson");
    const huge = "x".repeat(5 * 1024 * 1024);
    // Start from an idle queue whatever ran before this test, then put one
    // small record in flight.  `enqueue` starts a drain synchronously and
    // that drain takes its first entry off the queue before its first await,
    // so without a write already in flight the huge record would leave the
    // queue before `appendNative` returned and `pending` would read 0.
    await flushNativeTee();
    appendNative("t-huge-lead", { dir: "in", source: "acp", msg: { lead: true } });

    appendNative("t-huge", { dir: "in", source: "acp", msg: { result: { content: huge } } });

    // Queued, not written: the record is waiting in the tee's writer queue
    // behind the in-flight write when appendNative returns, and nothing has
    // touched its file yet.
    expect(nativeTeeStats().pending).toBeGreaterThanOrEqual(1);
    expect(existsSync(file)).toBe(false);

    await flushNativeTee();
    const log = readFileSync(file, "utf8");
    // The per-string cap from redactSecretsForLog, not the whole 5 MB.
    expect(log.length).toBeLessThan(LOG_TEE_MAX_STRING_CHARS + 4_096);
    expect(log).toContain("characters elided from log");
    expect(JSON.parse(log.trim()).msg.result.content.startsWith("xxxx")).toBe(true);
  });

  it("keeps records in publish order within a thread", async () => {
    for (let i = 0; i < 50; i++) appendNative("t-order", { dir: "in", source: "acp", msg: { seq: i } });
    await flushNativeTee();
    const seqs = readFileSync(join(NATIVE_DIR, "t-order.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).msg.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });
});

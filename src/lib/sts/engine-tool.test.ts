import { describe, expect, it, vi } from "vitest";
import {
  callBotEngine,
  composeStsInstructions,
  engineGeminiToolDefinition,
  engineToolDefinition,
  normalizeEngineTimeout,
} from "./engine-tool";
import { BOT_ENGINE_TOOL, DEFAULT_ENGINE_TIMEOUT_MS, type StsBotEngine } from "./types";

const engine = (run: StsBotEngine["run"]): StsBotEngine => ({
  name: BOT_ENGINE_TOOL,
  description: "Run the bot's own coding engine.",
  parameters: { type: "object", properties: { prompt: { type: "string" } } },
  run,
});

describe("normalizeEngineTimeout", () => {
  it("falls back to the default for absent or nonsensical values", () => {
    expect(normalizeEngineTimeout(undefined)).toBe(DEFAULT_ENGINE_TIMEOUT_MS);
    expect(normalizeEngineTimeout(0)).toBe(DEFAULT_ENGINE_TIMEOUT_MS);
    expect(normalizeEngineTimeout(-5)).toBe(DEFAULT_ENGINE_TIMEOUT_MS);
    expect(normalizeEngineTimeout(Number.NaN)).toBe(DEFAULT_ENGINE_TIMEOUT_MS);
  });

  it("rounds and caps", () => {
    expect(normalizeEngineTimeout(1500.6)).toBe(1501);
    expect(normalizeEngineTimeout(999_999)).toBe(120_000);
  });
});

describe("callBotEngine", () => {
  it("returns the engine reply when the engine answers", async () => {
    const out = await callBotEngine(
      engine(async () => "  the build is green  "),
      { prompt: "status" },
    );
    expect(out).toMatchObject({ ok: true, bypassed: false, text: "the build is green" });
  });

  it("bypasses with reason timeout when the engine overruns the deadline", async () => {
    vi.useFakeTimers();
    try {
      const never = engine(
        (_input, signal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );
      const pending = callBotEngine(never, { prompt: "go" }, { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      const out = await pending;
      expect(out.bypassed).toBe(true);
      expect(out.reason).toBe("timeout");
      expect(out.text).toMatch(/answer this turn yourself/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bypasses with reason engine-error when the engine throws", async () => {
    const boom = engine(async () => {
      throw new Error("workspace gone");
    });
    const out = await callBotEngine(boom, { prompt: "go" });
    expect(out).toMatchObject({ ok: false, bypassed: true, reason: "engine-error" });
  });

  it("treats an empty engine reply as a bypass rather than handing back a blank", async () => {
    const blank = engine(async () => "   ");
    const out = await callBotEngine(blank, { prompt: "go" });
    expect(out.bypassed).toBe(true);
    expect(out.reason).toBe("engine-error");
  });

  it("does not start work when the session was already torn down", async () => {
    const run = vi.fn(async () => "should not run");
    const controller = new AbortController();
    controller.abort();
    const out = await callBotEngine(engine(run), {}, { signal: controller.signal });
    expect(run).not.toHaveBeenCalled();
    expect(out).toMatchObject({ bypassed: true, reason: "engine-unavailable" });
  });

  it("aborts the engine when the outer session aborts mid-call", async () => {
    const controller = new AbortController();
    let sawAbort = false;
    const slow = engine(
      (_input, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted"));
          }, { once: true });
        }),
    );
    const pending = callBotEngine(slow, {}, { signal: controller.signal });
    controller.abort();
    const out = await pending;
    expect(sawAbort).toBe(true);
    expect(out.bypassed).toBe(true);
  });
});

describe("composeStsInstructions", () => {
  it("tells the model to delegate to the engine when one is available", () => {
    const out = composeStsInstructions("You are Codex, a coding bot.", {
      engineAvailable: true,
    });
    expect(out).toContain("You are Codex, a coding bot.");
    expect(out).toContain(BOT_ENGINE_TOOL);
    expect(out).toMatch(/before calling any tool/i);
    expect(out).toMatch(/never mention the/i);
  });

  it("tells the model to answer alone when no engine is available", () => {
    const out = composeStsInstructions("You are a voice assistant.", {
      engineAvailable: false,
    });
    expect(out).toMatch(/unavailable right now/i);
    expect(out).not.toContain(BOT_ENGINE_TOOL);
  });

  it("appends a language hint when given", () => {
    const out = composeStsInstructions("Persona.", { engineAvailable: false, language: "en" });
    expect(out).toContain("Speak in en.");
  });
});

describe("tool declarations", () => {
  it("emits xAI/realtime function form", () => {
    const def = engineToolDefinition(
      engine(async () => "ok"),
    );
    expect(def.type).toBe("function");
    expect(def.name).toBe(BOT_ENGINE_TOOL);
    expect(def.parameters).toMatchObject({ type: "object" });
  });

  it("emits Gemini function-declaration form", () => {
    const def = engineGeminiToolDefinition(engine(async () => "ok"));
    expect(Array.isArray(def)).toBe(true);
    expect(def[0]).toMatchObject({ name: BOT_ENGINE_TOOL });
  });
});
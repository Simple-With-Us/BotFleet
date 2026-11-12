import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import {
  latestRows,
  modelOptionLabel,
  offeredOptions,
  savedModelStatus,
  selectionChipLabel,
} from "./model-lineage-view";

const EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;

function instance(partial: Partial<InstanceInfo> & Pick<InstanceInfo, "instanceId" | "driverKind" | "models">): InstanceInfo {
  return {
    displayName: partial.instanceId,
    snapshot: { state: "available", authenticated: true },
    capabilities: { effortLevels: [...EFFORT] },
    ...partial,
  } as InstanceInfo;
}

const claude = instance({
  instanceId: "claude",
  driverKind: "claudeAgent",
  models: {
    default: "claude-sonnet-5-5",
    options: [
      { id: "claude-fable-5-1", label: "Claude Fable 5.1", effortLevels: [...EFFORT] },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", effortLevels: [...EFFORT] },
      { id: "claude-opus-5", label: "Claude Opus 5", effortLevels: [...EFFORT] },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", effortLevels: [...EFFORT] },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", effortLevels: [...EFFORT] },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", effortLevels: [] },
      { id: "ollama::qwen3", label: "Qwen 3", custom: true },
    ],
  },
});

const grok = instance({
  instanceId: "grok",
  driverKind: "grokAgent",
  models: {
    default: "grok-4.7",
    options: [
      { id: "grok-4.7", label: "Grok 4.7" },
      { id: "grok-4.7-build-fast", label: "Grok 4.7 Build Fast", badge: "2× $" },
      { id: "grok-4.6", label: "Grok 4.6" },
      { id: "grok-4.5", label: "Grok 4.5" },
    ],
  },
});

const codexLive = instance({
  instanceId: "codex",
  driverKind: "codex",
  models: {
    default: "gpt-5.6-luna",
    live: true,
    options: [
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
    ],
  },
});

describe("picker catalog", () => {
  it("hides superseded rows and keeps local rows", () => {
    expect(offeredOptions(claude).map((o) => o.id)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
      "ollama::qwen3",
    ]);
    expect(offeredOptions(grok).map((o) => o.id)).toEqual(["grok-4.7", "grok-4.7-build-fast"]);
  });

  it("offers Latest rows that name the model each one runs now", () => {
    expect(latestRows(claude).map((r) => `${r.label} → ${r.resolvedLabel}`)).toEqual([
      "Latest Fable → Claude Fable 5.1",
      "Latest Opus → Claude Opus 5.5",
      "Latest Sonnet → Claude Sonnet 5.5",
      "Latest Haiku → Claude Haiku 4.5",
    ]);
    expect(latestRows(grok).map((r) => r.label)).toEqual(["Latest Grok", "Latest Grok Build Fast"]);
    expect(latestRows(codexLive).map((r) => r.label)).toEqual(["Latest Astra", "Latest Sol", "Latest Luna"]);
  });
});

describe("chip text", () => {
  const floating = { instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" };

  it("shows the resolved slug's label in the chat header and says Latest in settings", () => {
    expect(selectionChipLabel(claude, floating, { showLatest: false })).toBe("Claude Sonnet 5.5");
    expect(selectionChipLabel(claude, floating, { showLatest: true })).toBe("Latest Sonnet · Claude Sonnet 5.5");
    expect(selectionChipLabel(claude, { ...floating, latest: null }, { showLatest: true })).toBe("Claude Sonnet 5.5");
  });

  it("labels a hidden or retired saved id readably instead of raw", () => {
    expect(modelOptionLabel(claude, "claude-3-7-sonnet")).toBe("Claude Sonnet 3.7");
    expect(modelOptionLabel(grok, "grok-4.6")).toBe("Grok 4.6");
  });
});

describe("saved model status", () => {
  it("flags a retired id and offers its Latest successor, keeping a supported effort", () => {
    const status = savedModelStatus(claude, { instanceId: "claude", model: "claude-3-7-sonnet", effort: "high" });
    expect(status).toEqual({
      kind: "retired",
      badge: "Retired",
      successor: { instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet", effort: "high" },
      successorLabel: "Latest Sonnet",
    });
  });

  it("flags an owner-retired Grok and an older Opus", () => {
    expect(savedModelStatus(grok, { instanceId: "grok", model: "grok-4.6" })).toMatchObject({
      kind: "retired",
      successor: { model: "grok-4.7", latest: "grok" },
      successorLabel: "Latest Grok",
    });
    expect(savedModelStatus(claude, { instanceId: "claude", model: "claude-opus-5" })).toMatchObject({
      kind: "superseded",
      badge: "Superseded",
      successorLabel: "Latest Opus",
    });
  });

  it("says Not in catalog only against a live catalog", () => {
    expect(savedModelStatus(codexLive, { instanceId: "codex", model: "gpt-4o" })).toEqual({
      kind: "not-in-catalog",
      badge: "Not in catalog",
    });
    const codexStatic = { ...codexLive, models: { ...codexLive.models, live: undefined } };
    expect(savedModelStatus(codexStatic, { instanceId: "codex", model: "gpt-4o" }).badge).toBeNull();
  });

  it("never flags a local row, a missing engine, or a disabled one", () => {
    expect(savedModelStatus(codexLive, { instanceId: "codex", model: "omlx::qwen3" }).badge).toBeNull();
    expect(savedModelStatus(undefined, { instanceId: "gone", model: "claude-3-7-sonnet" }).badge).toBeNull();
    expect(savedModelStatus({ ...claude, enabled: false }, { instanceId: "claude", model: "claude-3-7-sonnet" }).badge).toBeNull();
  });
});

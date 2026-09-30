// The load-time model-lineage migration (Store.reconcileModelLineage):
// owner-directed Latest flags once, retired and superseded ids forward on
// every pass, one notice per moved bot, and recorded usage left alone.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { Store, type BotRecord } from "./store.ts";
import { lineageContextFor, modelNameFor } from "./model-lineage.ts";
import { STATIC_CLAUDE_MODELS } from "./claude-models.ts";
import { STATIC_GROK_MODELS } from "./drivers/acp/grok.ts";
import { STATIC_CODEX_MODELS } from "./drivers/codex-catalog.ts";
import { OWNER_DIRECTED_LATEST } from "../shared/model-lineage.ts";

const CODEX_LIVE = {
  default: "gpt-5.6-luna",
  options: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"].map((id) => ({ id, label: id })),
};

let codexModels: { default: string; options: Array<{ id: string; label: string }> } = CODEX_LIVE;
const instance = (id: string) =>
  ({
    claude: { driverKind: "claudeAgent", models: STATIC_CLAUDE_MODELS },
    codex: { driverKind: "codex", models: codexModels },
    grok: { driverKind: "grokAgent", models: STATIC_GROK_MODELS },
    dsh: { driverKind: "dshAgent", models: { default: "DeepSeek-V4.1-Flash", options: [{ id: "DeepSeek-V4.1-Flash", label: "DeepSeek-V4.1-Flash" }] } },
  })[id];

const reconcile = (store: Store, ownerDirective = false) =>
  store.reconcileModelLineage({
    contextFor: (id) => lineageContextFor(instance(id)),
    nameFor: (id, model) => modelNameFor(instance(id)?.models, model),
    ownerDirective,
  });

function seedBots(bots: Array<Partial<BotRecord> & { id: string; modelSelection: ModelSelection }>) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(
    join(DATA_DIR, "bots.json"),
    JSON.stringify(
      bots.map((bot, i) => ({
        threadId: `thread-${bot.id}`,
        name: bot.id,
        title: "",
        description: "",
        notifications: false,
        color: "blue",
        unread: false,
        resumeCursors: {},
        createdAt: 1_000 + i,
        tasks: [{ threadId: `thread-${bot.id}`, title: "Main", createdAt: 1_000 + i, resumeCursors: {} }],
        ...bot,
      })),
    ),
  );
}

const notices = (store: Store, bot: BotRecord) =>
  store.messagesFor(bot.threadId).filter((m) => m.kind === "activity" && m.tool?.kind === "notice");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  rmSync(DATA_DIR, { recursive: true, force: true });
  codexModels = CODEX_LIVE;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Store.reconcileModelLineage", () => {
  it("moves the Deployer chain forward, floats Sonnet and Luna, and posts one notice", () => {
    seedBots([
      {
        id: "deployer",
        modelSelection: {
          instanceId: "dsh",
          model: "DeepSeek-V4.1-Flash",
          fallbacks: [
            { instanceId: "claude", model: "claude-3-7-sonnet" },
            { instanceId: "codex", model: "gpt-5.6-luna" },
            { instanceId: "grok", model: "grok-4.6" },
          ],
        },
        activeModelSelection: { instanceId: "claude", model: "claude-3-7-sonnet" },
      },
      { id: "plumber", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } },
      { id: "untouched", modelSelection: { instanceId: "claude", model: "claude-opus-5-5" } },
    ]);
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5-5" }));
    const results = reconcile(store, true);

    const deployer = store.bot("deployer")!;
    expect(deployer.modelSelection).toEqual({
      instanceId: "dsh",
      model: "DeepSeek-V4.1-Flash",
      fallbacks: [
        { instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" },
        { instanceId: "codex", model: "gpt-5.6-luna", latest: "luna" },
        { instanceId: "grok", model: "grok-4.7", latest: "grok" },
      ],
    });
    expect(deployer.activeModelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" });
    expect(store.bot("plumber")!.modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5", latest: "sonnet" });
    expect(store.bot("untouched")!.modelSelection).toEqual({ instanceId: "claude", model: "claude-opus-5-5" });

    expect(results.map((r) => r.botId)).toEqual(["deployer", "plumber"]);
    const [notice] = notices(store, deployer);
    expect(notices(store, deployer)).toHaveLength(1);
    expect(notice!.tool!.name).toBe(
      "Model update: fallback 1 Claude Sonnet 3.7 → Latest Sonnet (Claude Sonnet 5.5) · fallback 2 gpt-5.6-luna → Latest Luna (gpt-5.6-luna) · fallback 3 Grok 4.6 → Latest Grok (Grok 4.7)",
    );
    expect(notices(store, store.bot("untouched")!)).toHaveLength(0);

    const marker = JSON.parse(readFileSync(join(DATA_DIR, "model-lineage.json"), "utf8"));
    expect(marker.applied).toEqual([OWNER_DIRECTED_LATEST.id]);

    // The move is on disk, not just in memory.
    const onDisk = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as BotRecord[];
    expect(onDisk.find((b) => b.id === "deployer")!.modelSelection.fallbacks![0]).toEqual({
      instanceId: "claude",
      model: "claude-sonnet-5-5",
      latest: "sonnet",
    });
  });

  it("is idempotent and never re-floats a selection pinned after the one-time move", () => {
    seedBots([{ id: "plumber", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }]);
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5-5" }));
    reconcile(store, true);
    expect(reconcile(store, true)).toEqual([]);
    expect(notices(store, store.bot("plumber")!)).toHaveLength(1);

    // The person pins Sonnet 5.5 explicitly; a later boot must keep it pinned.
    store.patchBot("plumber", { modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" } });
    expect(reconcile(store, true)).toEqual([]);
    expect(store.bot("plumber")!.modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet-5-5" });
  });

  it("resolves Latest Luna only once the live catalog offers a newer Luna", () => {
    seedBots([{ id: "b", modelSelection: { instanceId: "codex", model: "gpt-5.6-luna", latest: "luna" } }]);
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5-5" }));

    // BotFleet's built-in fallback is not the account's answer, so nothing
    // resolves against it.
    codexModels = STATIC_CODEX_MODELS;
    expect(reconcile(store)).toEqual([]);
    expect(store.bot("b")!.modelSelection.model).toBe("gpt-5.6-luna");

    codexModels = { ...CODEX_LIVE, options: [...CODEX_LIVE.options, { id: "gpt-6-luna", label: "GPT-6 Luna" }] };
    reconcile(store);
    expect(store.bot("b")!.modelSelection).toEqual({ instanceId: "codex", model: "gpt-6-luna", latest: "luna" });
  });

  it("rewrites task selections and leaves recorded usage and message attribution alone", () => {
    seedBots([
      {
        id: "b",
        modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
        tasks: [
          {
            threadId: "thread-b",
            title: "Main",
            createdAt: 1,
            resumeCursors: {},
            modelSelection: { instanceId: "grok", model: "grok-4.5" },
            activeModelSelection: { instanceId: "grok", model: "grok-4.5" },
            usage: { input: 10, output: 5, costUsd: null, turns: 1 },
            usageByInstance: {
              grok: {
                input: 10,
                output: 5,
                costUsd: null,
                turns: 1,
                engineId: "grokAgent",
                byModel: { "grok-4.5": { input: 10, output: 5, costUsd: null, turns: 1 } },
              },
            },
          } as never,
        ],
      },
    ]);
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5-5" }));
    const reply = store.appendMessage("thread-b", {
      role: "bot",
      kind: "text",
      text: "done",
      modelSelection: { instanceId: "grok", model: "grok-4.5" },
    });
    reconcile(store, true);

    const task = store.tasks("b")[0]!;
    expect(task.modelSelection).toEqual({ instanceId: "grok", model: "grok-4.7", latest: "grok" });
    expect(task.activeModelSelection).toEqual({ instanceId: "grok", model: "grok-4.7", latest: "grok" });
    // No aliasing: the usage bucket and the reply keep the slug that ran.
    expect(Object.keys(task.usageByInstance!.grok!.byModel!)).toEqual(["grok-4.5"]);
    expect(store.messagesFor("thread-b").find((m) => m.id === reply.id)!.modelSelection).toEqual({
      instanceId: "grok",
      model: "grok-4.5",
    });
    expect(notices(store, store.bot("b")!)[0]!.tool!.name).toBe(
      "Model update: primary Grok 4.5 → Latest Grok (Grok 4.7) (task “Main”)",
    );
  });

  it("drops a fallback the move made identical to the primary but keeps a placeholder", () => {
    seedBots([
      {
        id: "b",
        modelSelection: {
          instanceId: "claude",
          model: "claude-opus-5-5",
          fallbacks: [
            { instanceId: "claude", model: "claude-opus-5" },
            { instanceId: "claude", model: "claude-opus-5-5" },
          ],
        },
      },
    ]);
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5-5" }));
    reconcile(store);
    expect(store.bot("b")!.modelSelection.fallbacks).toEqual([{ instanceId: "claude", model: "claude-opus-5-5" }]);
    expect(notices(store, store.bot("b")!)[0]!.tool!.name).toBe(
      "Model update: fallback 1 Claude Opus 5 removed (now the same as the primary)",
    );
  });

  it("leaves a working bot for its next dispatch when asked to skip busy bots", () => {
    seedBots([{ id: "b", modelSelection: { instanceId: "grok", model: "grok-4.6" } }]);
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5-5" }));
    store.patchBot("b", { busy: true });
    expect(store.reconcileModelLineage({
      contextFor: (id) => lineageContextFor(instance(id)),
      nameFor: (id, model) => modelNameFor(instance(id)?.models, model),
      skipBusy: true,
    })).toEqual([]);
    expect(store.bot("b")!.modelSelection.model).toBe("grok-4.6");
  });

  it("never writes the marker for an unreadable roster", () => {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "bots.json"), "{not json");
    const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5-5" }));
    reconcile(store, true);
    expect(existsSync(join(DATA_DIR, "model-lineage.json"))).toBe(false);
  });
});

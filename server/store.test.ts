// Store persistence contract: bots.json + messages-<threadId>.json are
// the durable record — everything here must survive a process restart
// except `busy`, which never does (no turn survives one either).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { insertMessage } from "./message-db.ts";
import { peerAllowKey } from "./peer-approval-key.ts";
import { resolveRoomMemberIds, Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

// saveBots() now debounces behind a real setTimeout (see store.ts). DATA_DIR
// is one fixed path shared by every test below (each beforeEach just wipes
// it), not a fresh temp dir per test — so a save left un-flushed at the end
// of one test would otherwise fire its real timer during a LATER test and
// overwrite whatever that test just wrote. Fake timers file-wide make that
// impossible: nothing fires until a test explicitly asks it to, and nothing
// carries over once the fake clock is torn down.
beforeEach(() => {
  // Scoped to just the timer functions — Date must stay real, since plenty
  // of tests below compare createdAt/updatedAt-style timestamps across
  // operations.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Store", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("createBot seeds a greeting and an onboarding card", () => {
    const store = new Store(selection);
    const bot = store.createBot();

    const messages = store.messagesFor(bot.threadId);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "bot", kind: "text" });
    expect(messages[1].kind).toBe("options");
    expect(messages[1].card?.options.length).toBeGreaterThan(1);
    expect(bot.modelSelection).toEqual(selection());
  });

  it("dismisses the onboarding quiz when the user talks, and leaves live asks", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const quiz = store.messagesFor(bot.threadId)[1]!;
    expect(quiz.card?.dismissed).toBeUndefined();

    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === quiz.id)?.card?.dismissed).toBe(true);

    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.messagesFor(bot.threadId).find((m) => m.id === quiz.id)?.card?.dismissed).toBe(true);

    const ask = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Approval needed",
        subtitle: "run rm",
        options: ["Allow", "Deny"],
        requestId: "req-1",
        tool: "Bash",
      },
    });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "later" });
    expect(store.messagesFor(bot.threadId).find((m) => m.id === ask.id)?.card?.dismissed).toBeUndefined();
  });

  it("does not dismiss the quiz for bot-authored messages", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "still here" });
    expect(store.messagesFor(bot.threadId)[1]?.card?.dismissed).toBeUndefined();
  });

  it("createBot with seedMessages:false starts with an empty transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Imported" }, { seedMessages: false });
    expect(store.messagesFor(bot.threadId)).toHaveLength(0);
  });

  it("addTaskUsage banks the engine kind and model that actually ran, and keeps them across later turns", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    // A turn that fell over to another engine banks under the instance
    // that ran, with the registry engine + model remembered — a deleted
    // custom connection must not drop the usage out of attribution.
    store.addTaskUsage(bot.id, bot.threadId, { input: 100, output: 20, costUsd: 0.01 }, "custom-work-mm", { engineId: "minimax", model: "minimax-m3" });
    store.addTaskUsage(bot.id, bot.threadId, { input: 50, output: 10, costUsd: 0.005 }, "custom-work-mm", { model: "minimax-m3" });
    const bucket = store.taskByThread(bot.id, bot.threadId)?.usageByInstance?.["custom-work-mm"];
    expect(bucket?.engineId).toBe("minimax");
    expect(bucket?.byModel?.["minimax-m3"]).toMatchObject({ input: 150, output: 30, turns: 2 });

    store.addRoomUsage(bot.id, "custom-work-mm", { input: 7, output: 3, costUsd: null }, { engineId: "minimax", model: "minimax-m3" });
    const roomBucket = store.bot(bot.id)?.roomUsageByInstance?.["custom-work-mm"];
    expect(roomBucket?.engineId).toBe("minimax");
    expect(roomBucket?.byModel?.["minimax-m3"]).toMatchObject({ input: 7, output: 3, turns: 1 });
    expect(typeof roomBucket?.lastAt).toBe("number");

    // The slug comes back pointing at a DIFFERENT engine: the old bucket
    // must keep its attribution, the new turns fork onto a suffixed key.
    store.addTaskUsage(bot.id, bot.threadId, { input: 9, output: 4, costUsd: 0.001 }, "custom-work-mm", { engineId: "deepseek-harness", model: "deepseek-v4" });
    const afterFork = store.taskByThread(bot.id, bot.threadId)?.usageByInstance;
    expect(afterFork?.["custom-work-mm"]?.engineId).toBe("minimax");
    expect(afterFork?.["custom-work-mm"]?.byModel?.["minimax-m3"]).toMatchObject({ input: 150, output: 30, turns: 2 });
    expect(afterFork?.["custom-work-mm~deepseek-harness"]?.engineId).toBe("deepseek-harness");
    expect(afterFork?.["custom-work-mm~deepseek-harness"]?.byModel?.["deepseek-v4"]).toMatchObject({ input: 9, output: 4, turns: 1 });
  });

  it("addTaskUsage forks a metadata-free legacy bucket instead of stamping it with the next engine", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    // Pre-upgrade record: turns banked with no engine metadata at all.
    store.addTaskUsage(bot.id, bot.threadId, { input: 500, output: 100, costUsd: 0.05 }, "custom-work-mm");
    // The first post-upgrade turn must fork, not stamp the whole bucket
    // with whatever engine happens to bank next.
    store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 2, costUsd: 0.001 }, "custom-work-mm", { engineId: "minimax", model: "minimax-m3" });
    const buckets = store.taskByThread(bot.id, bot.threadId)?.usageByInstance;
    expect(buckets?.["custom-work-mm"]?.engineId).toBeUndefined();
    expect(buckets?.["custom-work-mm"]).toMatchObject({ input: 500, output: 100, turns: 1 });
    expect(buckets?.["custom-work-mm~minimax"]?.engineId).toBe("minimax");
    expect(buckets?.["custom-work-mm~minimax"]).toMatchObject({ input: 10, output: 2, turns: 1 });
    // An empty bucket (no turns yet) takes the stamp without forking.
    store.addTaskUsage(bot.id, bot.threadId, { input: 5, output: 1, costUsd: null }, "custom-fresh", { engineId: "minimax", model: "minimax-m3" });
    const fresh = store.taskByThread(bot.id, bot.threadId)?.usageByInstance;
    expect(fresh?.["custom-fresh"]?.engineId).toBe("minimax");
  });

  it("addTaskUsage accumulates settled-turn totals per task and survives a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 1200, output: 300, cachedInput: 1000, costUsd: null })).toEqual({
      input: 1200,
      output: 300,
      cachedInput: 1000,
      costUsd: null,
      turns: 1,
    });
    // a driver that never reports the cached share leaves it unchanged
    store.addTaskUsage(bot.id, bot.threadId, { input: 800, output: 100, costUsd: null });
    store.addTaskUsage(bot.id, bot.threadId, { input: Number.NaN, output: -20, cachedInput: -5, costUsd: null });
    // Providers occasionally report a cache count larger than input; keep the
    // persisted share physically possible so percentages cannot exceed 100%.
    store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 0, cachedInput: 20, costUsd: null });
    // a different thread never inherits another task's tally
    expect(store.addTaskUsage(bot.id, "no-such-thread", { input: 5, output: 5, costUsd: null })).toBeNull();

    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.usage).toEqual({
      input: 2010,
      output: 400,
      cachedInput: 1010,
      costUsd: null,
      turns: 4,
    });
  });

  it("persists the per-bot composio gate", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { composio: false });
    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.composio).toBe(false);
  });

  it("persists connectorTools grants and clears them back to legacy via undefined", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.connectorTools).toBeUndefined();

    const grants = { gmail: { tools: "*" as const }, slack: { tools: ["SLACK_POST_MESSAGE"] } };
    store.patchBot(bot.id, { connectorTools: grants });
    expect(store.bot(bot.id)?.connectorTools).toEqual(grants);
    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.connectorTools).toEqual(grants);

    // parseBotProfilePatch's null clear resolves to a patch key present with
    // value undefined — Object.assign must still apply that key, not skip it.
    reloaded.patchBot(bot.id, { connectorTools: undefined });
    expect(reloaded.bot(bot.id)?.connectorTools).toBeUndefined();
    reloaded.flushBotsNow();
    const reloadedAgain = new Store(selection);
    expect(reloadedAgain.bot(bot.id)?.connectorTools).toBeUndefined();
  });

  it("rotates colors across created bots", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    expect(first.color).not.toBe(second.color);
  });

  it("defaults a room to its first member and repairs the lead when membership changes", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Team", [first.id, second.id]);

    expect(group.defaultResponder).toEqual({ kind: "member", botId: first.id });
    store.patchGroup(group.id, { memberIds: [second.id] });
    expect(group.defaultResponder).toEqual({ kind: "member", botId: second.id });

    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: second.id });
  });

  it("persists a channel's context when it is created", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Website launch", [bot.id], false, "Work");

    expect(channel.section).toBe("Work");
    store.flushBotsNow();
    expect(new Store(selection).group(channel.id)?.section).toBe("Work");
  });

  it("persists a channel's completed setup in the same create write", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const channel = store.createGroup("Launch", [bot.id], false, "Work", {
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      completed: true,
    });

    expect(channel).toMatchObject({
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      setupSkippedAt: null,
    });
    expect(channel.setupCompletedAt).toEqual(expect.any(Number));
    store.flushBotsNow();
    expect(new Store(selection).group(channel.id)).toMatchObject({
      bulletin: "Ship carefully.",
      defaultResponder: { kind: "mentions" },
      setupCompletedAt: channel.setupCompletedAt,
    });
  });

  it("migrates old rooms without routing to their first member", () => {
    const store = new Store(selection);
    const first = store.createBot();
    const second = store.createBot();
    const group = store.createGroup("Legacy team", [first.id, second.id]);
    const groupsFile = join(DATA_DIR, "groups.json");
    const saved = JSON.parse(readFileSync(groupsFile, "utf8"));
    delete saved[0].defaultResponder;
    writeFileSync(groupsFile, JSON.stringify(saved));

    // Group load filters memberIds down to bots it can find via this.bot(id)
    // — first/second must already be on disk or the reload sees no live
    // members at all.
    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.group(group.id)?.defaultResponder).toEqual({ kind: "member", botId: first.id });
  });

  it("persists bots and messages across a restart, resetting busy", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { name: "Testy", busy: true });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi there" });

    store.flushBotsNow();
    const reloaded = new Store(selection);
    const back = reloaded.bot(bot.id)!;
    expect(back.name).toBe("Testy");
    expect(back.busy).toBe(false);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.at(-1)).toMatchObject({ role: "user", text: "hi there" });
  });

  it("normalizes persisted cloud backends without changing valid or absent values", () => {
    const store = new Store(selection);
    const box = store.createBot();
    const vps = store.createBot();
    const invalid = store.createBot();
    const absent = store.createBot();
    store.flushBotsNow();
    const raw: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    raw.find((bot) => bot.id === box.id)!.cloudBackend = "box";
    raw.find((bot) => bot.id === vps.id)!.cloudBackend = "vps";
    (raw.find((bot) => bot.id === invalid.id) as unknown as { cloudBackend: string }).cloudBackend = "daytona";
    delete raw.find((bot) => bot.id === absent.id)!.cloudBackend;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(box.id)?.cloudBackend).toBe("box");
    expect(reloaded.bot(vps.id)?.cloudBackend).toBe("vps");
    expect(reloaded.bot(invalid.id)?.cloudBackend).toBeUndefined();
    expect(reloaded.bot(absent.id)?.cloudBackend).toBeUndefined();

    reloaded.flushBotsNow();
    const saved: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(saved.find((bot) => bot.id === box.id)?.cloudBackend).toBe("box");
    expect(saved.find((bot) => bot.id === vps.id)?.cloudBackend).toBe("vps");
    expect(saved.find((bot) => bot.id === invalid.id)).not.toHaveProperty("cloudBackend");
    expect(saved.find((bot) => bot.id === absent.id)).not.toHaveProperty("cloudBackend");
  });

  it("migrates unambiguous legacy peer grants without guessing duplicate names", () => {
    const store = new Store(selection);
    const requester = store.createBot();
    const helper = store.patchBot(store.createBot().id, { name: "Helper" })!;
    store.patchBot(store.createBot().id, { name: "Twin" });
    store.patchBot(store.createBot().id, { name: "Twin" });
    store.patchBot(requester.id, {
      alwaysAllow: ["ask_bot:@Helper", "delegate_bot:@Twin", "Bash:git status"],
    });

    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.bot(requester.id)?.alwaysAllow).toEqual([
      peerAllowKey("ask_bot", helper.id),
      "delegate_bot:@Twin",
      "Bash:git status",
    ]);

    reloaded.flushBotsNow();
    const persisted: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(persisted.find((bot) => bot.id === requester.id)?.alwaysAllow).toEqual(
      reloaded.bot(requester.id)?.alwaysAllow,
    );
  });

  it("persists a bot's effort level across a restart, defaulting to unset", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.modelSelection.effort).toBeUndefined();

    store.patchBot(bot.id, { modelSelection: { ...bot.modelSelection, effort: "high" } });

    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.modelSelection.effort).toBe("high");
  });

  it("keeps one persisted Chief of Staff per section and supports handoff", () => {
    const store = new Store(selection);
    const first = store.createBot({ section: "Work" });
    const second = store.createBot({ section: "Work" });
    const personal = store.createBot({ section: "Personal" });

    expect(store.setChiefOfStaff(first.id)?.map((bot) => bot.id)).toEqual([first.id]);
    expect(store.bot(first.id)?.chiefOfStaff).toBe(true);
    expect(store.setChiefOfStaff(personal.id)?.map((bot) => bot.id)).toEqual([personal.id]);

    const changed = store.setChiefOfStaff(second.id)!;
    expect(changed.map((bot) => bot.id).sort()).toEqual([first.id, second.id].sort());
    expect(store.bot(first.id)?.chiefOfStaff).toBe(false);
    expect(store.bot(second.id)?.chiefOfStaff).toBe(true);
    expect(store.bot(personal.id)?.chiefOfStaff).toBe(true);

    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.bots.filter((bot) => bot.chiefOfStaff).map((bot) => bot.id).sort()).toEqual(
      [second.id, personal.id].sort(),
    );
    expect(reloaded.setChiefOfStaff(null, "Work")?.map((bot) => bot.id)).toEqual([second.id]);
    expect(reloaded.bot(personal.id)?.chiefOfStaff).toBe(true);
    expect(reloaded.bot(second.id)?.chiefOfStaff).toBe(false);
  });

  it("patchMessage merges card patches and returns null for unknown ids", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.messagesFor(bot.threadId)[1];

    const patched = store.patchMessage(bot.threadId, card.id, {
      card: { ...card.card!, answered: "Work & projects" },
    });
    expect(patched?.card?.answered).toBe("Work & projects");
    expect(store.patchMessage(bot.threadId, "nope", {})).toBeNull();
  });


  it("setResumeCursor persists per-instance continuations", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-abc");
    store.setResumeCursor(bot.id, "codex", "thread-xyz");

    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.resumeCursors).toEqual({ claude: "sess-abc", codex: "thread-xyz" });
  });

  it("setResumeCursor deletes per-instance continuations when cursor is undefined", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "claude", "sess-abc");
    store.setResumeCursor(bot.id, "claude", undefined);

    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.resumeCursors).toEqual({});
  });

  it("clearResumeCursor drops only the cursor it names, durably", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setResumeCursor(bot.id, "codex", "thread-rejected", bot.threadId);
    store.setResumeCursor(bot.id, "claude", "sess-keep", bot.threadId);
    // A stale invalidation (a newer thread was saved since) is a no-op.
    store.clearResumeCursor(bot.id, "claude", "sess-older", bot.threadId);
    store.clearResumeCursor(bot.id, "codex", "thread-rejected", bot.threadId);

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.resumeCursors).toEqual({ claude: "sess-keep" });
    expect(reloaded.taskByThread(bot.id, bot.threadId)?.resumeCursors).toEqual({ claude: "sess-keep" });
  });

  it("seedIfEmpty creates exactly one starter bot, once", () => {
    const store = new Store(selection);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);

    store.flushBotsNow();
    const reloaded = new Store(selection);
    reloaded.seedIfEmpty();
    expect(reloaded.bots).toHaveLength(1);
  });

  it("chains appended messages and keeps the newest as active leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const user = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });

    const messages = store.messagesFor(bot.threadId);
    expect(user.parentId).toBe(messages[1].id); // follows the onboarding card
    expect(store.activeLeaf(bot.threadId)).toBe(user.id);
    expect(store.activePath(bot.threadId).map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  it("branchMessage forks at the edited message and hides the old tail", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });

    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;
    expect(edited.parentId).toBe(original.parentId); // sibling, not child
    expect(store.activeLeaf(bot.threadId)).toBe(edited.id);

    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v2");
    expect(path.map((m) => m.text)).not.toContain("v1");
    expect(path.map((m) => m.id)).not.toContain(reply.id);
    // the abandoned branch still exists in the tree
    expect(store.messagesFor(bot.threadId).map((m) => m.id)).toContain(original.id);

    expect(store.branchMessage(bot.threadId, "nope", "x")).toBeNull();
  });

  it("branchMessage retains delegated attribution but drops the stale peer-thread link", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const from = { botId: "sender", name: "Compiler", color: "blue" };
    const comm = { groupId: "peer-thread", withBotId: "sender", withName: "Compiler", withColor: "blue" };
    const original = store.appendMessage(bot.threadId, {
      role: "system", kind: "text", text: "Run CI",
      automationSource: "delegation", from, comm,
    });

    const edited = store.branchMessage(bot.threadId, original.id, "Run tests")!;
    expect(edited).toMatchObject({ role: "system", automationSource: "delegation", from });
    expect(edited.from).not.toBe(original.from);
    expect(edited.comm).toBeUndefined();
    const regenerated = store.branchMessage(bot.threadId, edited.id, "Run tests")!;
    expect(regenerated).toMatchObject({ role: "system", automationSource: "delegation", from });
    expect(regenerated.comm).toBeUndefined();
    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.messagesFor(bot.threadId).find((message) => message.id === regenerated.id))
      .toMatchObject({ role: "system", automationSource: "delegation", from });
  });

  it("setActiveLeaf switches branches and descends to the newest leaf", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });
    store.branchMessage(bot.threadId, original.id, "v2");
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v2" });

    // back to the original branch: the leaf is v1's reply, not v1 itself
    expect(store.setActiveLeaf(bot.threadId, original.id)).toBe(reply.id);
    const path = store.activePath(bot.threadId);
    expect(path.map((m) => m.text)).toContain("v1");
    expect(path.map((m) => m.text)).not.toContain("v2");

    expect(store.setActiveLeaf(bot.threadId, "nope")).toBeNull();
  });

  it("persists the branch tree and active leaf across a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    const edited = store.branchMessage(bot.threadId, original.id, "v2")!;

    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.activeLeaf(bot.threadId)).toBe(edited.id);
    expect(reloaded.messagesFor(bot.threadId).map((m) => m.text)).toContain("v1");
    expect(reloaded.activePath(bot.threadId).map((m) => m.text)).not.toContain("v1");
  });


  it("tolerates a corrupt bots.json by starting empty", () => {
    const store = new Store(selection);
    store.createBot();
    writeFileSync(join(DATA_DIR, "bots.json"), "{not json");

    const reloaded = new Store(selection);
    expect(reloaded.bots).toEqual([]);
  });

  it("does not strip room rosters when bots.json is corrupt", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Lead" });
    const room = store.createGroup("Ops", [bot.id]);
    expect(room.memberIds).toEqual([bot.id]);
    writeFileSync(join(DATA_DIR, "bots.json"), "{not json");

    const reloaded = new Store(selection);
    expect(reloaded.bots).toEqual([]);
    expect(reloaded.group(room.id)?.memberIds).toEqual([bot.id]);
    expect(reloaded.group(room.id)?.defaultResponder).toEqual({ kind: "member", botId: bot.id });
  });

  it("busy is wiped even when bots.json says otherwise", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.flushBotsNow();
    const raw: BotRecord[] = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    raw.find((b) => b.id === bot.id)!.busy = true;
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify(raw));

    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.busy).toBe(false);
  });
  it("createBot with seedMessages:false starts with an empty transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Imported" }, { seedMessages: false });
    expect(store.messagesFor(bot.threadId)).toHaveLength(0);
  });

  it("persists the per-bot composio gate", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { composio: false });
    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.bot(bot.id)?.composio).toBe(false);
  });

  it("deleteBot removes the bot and its durable transcript", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.flushBotsNow();
    // the transcript is durable — a fresh Store sees the seeded messages
    expect(new Store(selection).messagesFor(bot.threadId).length).toBeGreaterThan(0);

    expect(store.deleteBot(bot.id)).toBe(true);
    expect(store.bot(bot.id)).toBeNull();
    store.flushBotsNow();
    expect(new Store(selection).messagesFor(bot.threadId)).toHaveLength(0);
    expect(store.deleteBot(bot.id)).toBe(false);
  });

  it("deleteBot strips the id from every room roster and reassigns the lead", () => {
    const store = new Store(selection);
    const lead = store.createBot({ name: "Lead" });
    const other = store.createBot({ name: "Other" });
    const room = store.createGroup("Ops", [lead.id, other.id]);
    expect(room.defaultResponder).toEqual({ kind: "member", botId: lead.id });

    expect(store.deleteBot(lead.id)).toBe(true);
    const leftover = store.group(room.id);
    expect(leftover?.memberIds).toEqual([other.id]);
    expect(leftover?.defaultResponder).toEqual({ kind: "member", botId: other.id });

    expect(store.deleteBot(other.id)).toBe(true);
    const empty = store.group(room.id);
    expect(empty?.memberIds).toEqual([]);
    expect(empty?.defaultResponder).toEqual({ kind: "mentions" });
  });

  it("resolveRoomMemberIds drops roster ghosts and refuses newly invented ids", () => {
    const exists = (id: string) => id === "live";
    expect(resolveRoomMemberIds(["live", "ghost"], ["live", "ghost"], exists)).toEqual({
      ok: true,
      memberIds: ["live"],
    });
    expect(resolveRoomMemberIds(["live", "invented"], ["live"], exists)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unknown channel member: invented/),
    });
    expect(resolveRoomMemberIds(["ghost"], ["ghost"], exists)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/at least one bot/),
    });
    expect(resolveRoomMemberIds(["invented"], undefined, exists)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unknown channel member: invented/),
    });
    expect(resolveRoomMemberIds("nope", undefined, exists)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/list of bot IDs/),
    });
  });

  it("reloads drop deleted-bot ids left on a room roster", () => {
    const store = new Store(selection);
    const bot = store.createBot({ name: "Keeper" });
    const room = store.createGroup("Ops", [bot.id]);
    store.patchGroup(room.id, { memberIds: [bot.id, "ghost-from-before-deleteBot"] });
    expect(store.group(room.id)?.memberIds).toEqual([bot.id, "ghost-from-before-deleteBot"]);

    // bot must be on disk or the live-member filter below finds neither id
    // and drops both, not just the ghost.
    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.group(room.id)?.memberIds).toEqual([bot.id]);
  });

  it("does not strip a direct-message pair on reload when the ids are not live bots", () => {
    const store = new Store(selection);
    const dm = store.createGroup("Private", ["test-bot-a", "test-bot-b"], true);
    const reloaded = new Store(selection);
    expect(reloaded.group(dm.id)?.memberIds).toEqual(["test-bot-a", "test-bot-b"]);
  });

  it("migrates a pre-branching flat transcript file", () => {
    const store = new Store(selection);
    // seedMessages:false — a legacy-era thread has its history ONLY in the
    // JSON file; any DB rows would (correctly) take precedence over it
    const bot = store.createBot({}, { seedMessages: false });
    const legacy = [
      { id: "m1", role: "bot", kind: "text", text: "hello", at: 1 },
      { id: "m2", role: "user", kind: "text", text: "hi", at: 2 },
    ];
    writeFileSync(join(DATA_DIR, `messages-${bot.threadId}.json`), JSON.stringify(legacy));

    store.flushBotsNow();
    const reloaded = new Store(selection);
    const messages = reloaded.messagesFor(bot.threadId);
    expect(messages.map((m) => m.parentId)).toEqual([null, "m1"]);
    expect(reloaded.activeLeaf(bot.threadId)).toBe("m2");
    expect(reloaded.activePath(bot.threadId).map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("Store change stream", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const record = (store: Store) => {
    const events: Array<Record<string, unknown>> = [];
    store.onChange((e) => events.push(e as unknown as Record<string, unknown>));
    return events;
  };

  it("emits once per write, after the write, with the record it wrote", () => {
    const store = new Store(selection);
    // no first-run quiz: a user append is exactly one write
    const bot = store.createBot({ name: "Quiet" }, { seedMessages: false });
    const events = record(store);
    const m = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(events).toEqual([{ type: "message", threadId: bot.threadId, message: m }]);
    // the emitted record is the stored one (redacted, id'd) — not the input
    expect(store.messagesFor(bot.threadId).at(-1)).toBe(m);
  });

  it("emits a card patch after a user message hides the onboarding quiz", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const quiz = store.messagesFor(bot.threadId)[1]!;
    const events = record(store);
    const m = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    expect(events.map((event) => event.type)).toEqual(["message", "message.patch"]);
    expect(events[0]).toEqual({ type: "message", threadId: bot.threadId, message: m });
    expect(events[1]).toMatchObject({
      type: "message.patch",
      threadId: bot.threadId,
      message: { id: quiz.id, card: { dismissed: true } },
    });
  });

  it("announces a new bot before its onboarding messages", () => {
    const store = new Store(selection);
    const events = record(store);
    const bot = store.createBot();
    expect(events.map((event) => event.type)).toEqual(["bot", "message", "message"]);
    expect(events[0]).toEqual({ type: "bot", botId: bot.id });
    expect(events.slice(1).every((event) => event.threadId === bot.threadId)).toBe(true);
  });

  it("every message-tree write emits a message or thread event", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "a" });
    const events = record(store);
    store.patchMessage(bot.threadId, first.id, { text: "a2" });
    store.branchMessage(bot.threadId, first.id, "b");
    store.setActiveLeaf(bot.threadId, first.id);
    store.toggleReaction(bot.threadId, first.id, "👍", "user");
    expect(events.map((e) => e.type)).toEqual(["message.patch", "message", "thread", "message.patch"]);
    expect(events[2]).toMatchObject({ type: "thread", threadId: bot.threadId, activeLeafId: expect.any(String) });
  });

  it("announces screen frames whose pixels are pruned", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: "frame-1" });
    for (let i = 2; i <= 4; i += 1) {
      store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: `frame-${i}` });
    }
    const events = record(store);
    const newest = store.appendMessage(bot.threadId, { role: "bot", kind: "screen", png: "frame-5" });
    expect(events).toEqual([
      { type: "message.patch", threadId: bot.threadId, message: { ...first, png: undefined } },
      { type: "message", threadId: bot.threadId, message: newest },
    ]);
  });

  it("every bot write emits a bot event carrying only the id (the wire shape is the caller's)", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const events = record(store);
    store.patchBot(bot.id, { name: "Zed" });
    store.createTask(bot.id, "t2");
    store.switchTask(bot.id, bot.threadId);
    store.renameTask(bot.id, bot.threadId, "renamed");
    store.setResumeCursor(bot.id, "claude", "s1", bot.threadId);
    store.pinTaskCwd(bot.id, bot.threadId, "/private/workspace");
    store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 5, costUsd: null });
    expect(events.every((e) => e.type === "bot" && e.botId === bot.id)).toBe(true);
    expect(events).toHaveLength(7);
    store.deleteBot(bot.id);
    expect(events).toContainEqual({ type: "thread.deleted", threadId: bot.threadId });
    expect(events.at(-1)).toEqual({ type: "bot.deleted", botId: bot.id });
  });

  it("group writes emit group events; a listener that throws never breaks the write", () => {
    const store = new Store(selection);
    const a = store.createBot();
    const b = store.createBot();
    const events = record(store);
    store.onChange(() => {
      throw new Error("bad listener");
    });
    const g = store.createGroup("ops", [a.id, b.id]);
    store.patchGroup(g.id, { unread: true });
    expect(events.map((e) => e.type)).toEqual(["group", "group"]);
    expect(store.group(g.id)?.unread).toBe(true);
    store.deleteGroup(g.id);
    expect(events).toContainEqual({ type: "thread.deleted", threadId: g.threadId });
    expect(events.at(-1)).toEqual({ type: "group.deleted", groupId: g.id });
  });

  it("unsubscribe stops delivery", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: unknown[] = [];
    const off = store.onChange((e) => seen.push(e));
    off();
    store.patchBot(bot.id, { name: "x" });
    expect(seen).toEqual([]);
  });
});

describe("Store bot activity state", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("derives busy from activity, so every existing busy reader keeps working", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(bot.activity ?? "idle").toBe("idle");
    expect(Boolean(bot.busy)).toBe(false);
    for (const [state, busy] of [
      ["working", true],
      ["waiting-on-you", true],
      ["no-signal", true],
      ["idle", false],
      ["dead", false],
    ] as const) {
      store.setActivity(bot.id, state);
      expect(store.bot(bot.id)?.activity).toBe(state);
      expect(Boolean(store.bot(bot.id)?.busy)).toBe(busy);
    }
  });

  it("emits a bot change per transition and skips a no-op", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const seen: string[] = [];
    store.onChange((c) => seen.push(c.type));
    store.setActivity(bot.id, "working");
    store.setActivity(bot.id, "working");
    store.setActivity(bot.id, "idle");
    expect(seen).toEqual(["bot", "bot"]);
  });

  it("neither activity nor busy survives a restart", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.setActivity(bot.id, "waiting-on-you");
    // setActivity() no longer saves at all (see below) — flush so the bot's
    // EXISTENCE (from createBot) is on disk for the reload to find it.
    store.flushBotsNow();
    const again = new Store(selection);
    expect(again.bot(bot.id)?.activity).toBe("idle");
    expect(Boolean(again.bot(bot.id)?.busy)).toBe(false);
  });

  it("never writes bots.json on an activity transition, and never persists busy/activity at all", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.flushBotsNow();
    const bytesBefore = readFileSync(join(DATA_DIR, "bots.json"), "utf8");

    store.setActivity(bot.id, "working");
    store.setActivity(bot.id, "waiting-on-you");
    store.setActivity(bot.id, "idle");

    // Nothing dirtied the debounce — a real flush right after is a no-op,
    // proven by the file being byte-for-byte unchanged.
    store.flushBotsNow();
    expect(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).toBe(bytesBefore);

    // A save triggered for an unrelated reason must still exclude both
    // fields from the roster entirely, not merely reset them.
    store.patchBot(bot.id, { name: "Unrelated save" });
    store.setActivity(bot.id, "working");
    store.flushBotsNow();
    const raw = readFileSync(join(DATA_DIR, "bots.json"), "utf8");
    expect(raw).not.toContain('"busy"');
    expect(raw).not.toContain('"activity"');
  });
});

describe("Store redacts bot-authored secrets on write", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("masks a key in bot text, tools and cards — but never in what the user typed", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const key = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const reply = store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: `Your key is ${key}` });
    expect(reply.text).not.toContain(key);
    expect(reply.text).toContain("«redacted");
    const chip = store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `Bash: export TOKEN=${key}`, ok: true } });
    expect(chip.tool?.name).not.toContain(key);
    const card = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: { title: "Run this?", summary: `curl -H "Authorization: Bearer ${key}"`, held: `Blocked ${key}`, options: [], requestId: "r1", tool: "Bash" } as never,
    });
    expect((card.card as { summary?: string }).summary).not.toContain(key);
    expect(card.card?.held).not.toContain(key);
    const routineCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "options",
      card: {
        title: "Confirm routine",
        subtitle: "Every morning",
        options: ["Confirm", "Cancel"],
        requestId: "routine-request",
        tool: "schedule_routine",
        routineRequest: {
          version: 1,
          requestId: "routine-request",
          botId: bot.id,
          threadId: bot.threadId,
          createdAt: 1,
          operation: {
            action: "create",
            routine: {
              name: `Use ${key}`,
              instructions: `Send a request with ${key}`,
              schedule: { type: "daily", time: "09:00", weekdays: [1] },
              runOn: "bot",
              durationMinutes: 30,
            },
          },
        },
      },
    });
    expect(routineCard.card?.routineRequest?.operation.action).toBe("create");
    if (routineCard.card?.routineRequest?.operation.action !== "create") throw new Error("missing routine payload");
    expect(routineCard.card.routineRequest.operation.routine.name).not.toContain(key);
    expect(routineCard.card.routineRequest.operation.routine.instructions).not.toContain(key);
    const secretCard = store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "secret",
      secret: {
        target: "xaiApiKey",
        label: "xAI API key",
        description: `The agent accidentally included ${key}`,
        placeholder: "xai-…",
        helpUrl: "https://console.x.ai/",
        requestKey: "credential-request",
      },
    });
    expect(secretCard.secret?.description).not.toContain(key);
    // the user's own words are theirs
    const mine = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `use ${key} for the api` });
    expect(mine.text).toContain(key);
    // and the stored copy is what was masked, not just the returned one
    store.flushBotsNow();
    const again = new Store(selection);
    expect(again.messagesFor(bot.threadId).find((m) => m.id === reply.id)?.text).not.toContain(key);
  });
});

describe("Store task usage", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("banks each turn's tokens and cost on the task, counting turns", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 100, output: 20, costUsd: 0.01 })).toEqual({
      input: 100,
      output: 20,
      costUsd: 0.01,
      turns: 1,
    });
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 50, output: 5, costUsd: 0.005 })).toEqual({
      input: 150,
      output: 25,
      costUsd: 0.015,
      turns: 2,
    });
    expect(store.taskByThread(bot.id, bot.threadId)?.usage).toEqual({ input: 150, output: 25, costUsd: 0.015, turns: 2 });
  });

  it("keeps cost null until some turn reports one, then sums only reported costs", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: null })?.costUsd).toBeNull();
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: 0.02 })?.costUsd).toBe(0.02);
    expect(store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: null })?.costUsd).toBe(0.02);
  });

  it("counts estimated subscription turns without adding their equivalent price to actual spend", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.addTaskUsage(bot.id, bot.threadId, { input: 10, output: 1, costUsd: 0.02 });

    expect(store.addTaskUsage(bot.id, bot.threadId, {
      input: 20,
      output: 2,
      costUsd: 0.03,
      billingMode: "estimated",
    })).toEqual({ input: 30, output: 3, costUsd: 0.02, turns: 2 });
  });

  it("counts a turn that reported no tokens at all", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, bot.threadId, { costUsd: null })).toEqual({ input: 0, output: 0, costUsd: null, turns: 1 });
  });

  it("ignores an unknown task", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.addTaskUsage(bot.id, "nope", { input: 1, output: 1, costUsd: null })).toBeNull();
  });
});

describe("Store task working folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("pins the bot's folder onto a task on its first turn, and never again", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });

    // first turn: nothing pinned yet → takes the bot's folder
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBe("/tmp/project-a");

    // the bot's folder moves on; this task stays where its session started
    store.patchBot(bot.id, { cwd: "/tmp/project-b" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");

    // a new task starts in the bot's current folder
    const next = store.createTask(bot.id, "second")!;
    expect(store.pinTaskCwd(bot.id, next.threadId)).toBe("/tmp/project-b");
  });

  it("reuses a task stamped with the same automation key instead of minting another", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const first = store.createTask(bot.id, "Morning brief", false, "routine:r1")!;
    const again = store.createTask(bot.id, "Morning brief", false, "routine:r1")!;
    expect(again.threadId).toBe(first.threadId);
    expect(store.tasks(bot.id).filter((t) => t.automationKey === "routine:r1")).toHaveLength(1);
    const other = store.createTask(bot.id, "Evening", false, "routine:r2")!;
    expect(other.threadId).not.toBe(first.threadId);
  });

  it("stamps an automation key onto an existing thread", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.stampAutomationKey(bot.id, bot.threadId, "webhook:wh_1")?.automationKey).toBe("webhook:wh_1");
    expect(store.taskByAutomationKey(bot.id, "webhook:wh_1")?.threadId).toBe(bot.threadId);
    expect(store.stampAutomationKey(bot.id, bot.threadId, "routine:other")?.automationKey).toBe("webhook:wh_1");
  });

  it("pins the default (null) when the bot has no folder, so a later folder can't move a live session", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBeNull();
  });

  it("pins a supplied private workspace when the bot has no custom folder", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    expect(store.pinTaskCwd(bot.id, bot.threadId, "/private/bot-workspace")).toBe("/private/bot-workspace");
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBe("/private/bot-workspace");
  });

  it("a legacy task that already has a session pins to the default, not the bot's new folder", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    // an older build ran turns here before folders existed
    store.setResumeCursor(bot.id, "claude", "sess-1", bot.threadId);
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
  });
});

describe("Store room working folder", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("pins the room's folder on its first turn, and never again", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const group = store.createGroup("Team", [bot.id]);
    store.patchGroup(group.id, { cwd: "/tmp/project-a" });

    // first turn: nothing pinned yet → takes the room's folder
    expect(store.pinGroupCwd(group.id)).toBe("/tmp/project-a");
    expect(store.group(group.id)?.pinnedCwd).toBe("/tmp/project-a");

    // the room's folder moves on; the thread stays where it started working
    store.patchGroup(group.id, { cwd: "/tmp/project-b" });
    expect(store.pinGroupCwd(group.id)).toBe("/tmp/project-a");

    // the pin is durable — a restart must not re-pin from the new folder
    store.flushBotsNow();
    const reloaded = new Store(selection);
    expect(reloaded.pinGroupCwd(group.id)).toBe("/tmp/project-a");
  });

  it("pins the default (null) when the room has no folder, so a later folder can't move a running room", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    const group = store.createGroup("Team", [bot.id]);
    expect(store.pinGroupCwd(group.id)).toBeNull();
    store.patchGroup(group.id, { cwd: "/tmp/project-a" });
    expect(store.pinGroupCwd(group.id)).toBeNull();
    expect(store.group(group.id)?.pinnedCwd).toBeNull();
  });
});

describe("Store task working folder — cloud runs", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  it("a cloud run pins the default so the bot's host folder never shows for that task", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchBot(bot.id, { cwd: "/tmp/project-a" });
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBe("/tmp/project-a");
    expect(store.pinTaskCwd(bot.id, bot.threadId, undefined, { none: true })).toBeNull();
    expect(store.taskByThread(bot.id, bot.threadId)?.cwd).toBeNull();
    // and it stays pinned even if a host run follows
    expect(store.pinTaskCwd(bot.id, bot.threadId)).toBeNull();
  });
});

describe("Store patchBot modelSelection", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("clears activeModelSelection on inheriting tasks when bot modelSelection changes", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchTask(bot.id, bot.threadId, {
      activeModelSelection: { instanceId: "fallback", model: "fallback-model" },
    });
    expect(store.taskByThread(bot.id, bot.threadId)?.activeModelSelection).toEqual({
      instanceId: "fallback",
      model: "fallback-model",
    });

    store.patchBot(bot.id, {
      modelSelection: { instanceId: "grok", model: "grok-4" },
    });

    expect(store.taskByThread(bot.id, bot.threadId)?.activeModelSelection).toBeUndefined();
  });

  it("preserves activeModelSelection on tasks with their own modelSelection override", () => {
    const store = new Store(selection);
    const bot = store.createBot();
    store.patchTask(bot.id, bot.threadId, {
      modelSelection: { instanceId: "custom", model: "custom-model" },
      activeModelSelection: { instanceId: "custom", model: "custom-model" },
    });

    store.patchBot(bot.id, {
      modelSelection: { instanceId: "grok", model: "grok-4" },
    });

    expect(store.taskByThread(bot.id, bot.threadId)?.activeModelSelection).toEqual({
      instanceId: "custom",
      model: "custom-model",
    });
  });
});

// HS12/HS21: GET /api/bots used to hydrate every bot and group's thread
// through an unbounded cache — one request against a large database
// pulled every thread into the heap for the life of the process.
describe("Store thread cache", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    // a couple of these tests seed rows via message-db directly, before
    // any Store exists to create DATA_DIR itself
    mkdirSync(DATA_DIR, { recursive: true });
  });

  it("messagesTail reads a bounded page without caching the whole thread", () => {
    const threadId = "long-thread";
    // seeded directly through sqlite, bypassing Store, so this thread has
    // never been hydrated into any Store's cache before messagesTail runs.
    // parentId is chained explicitly, same as Store.appendMessage would —
    // an omitted parentId reads back as undefined and is what marks a row
    // as pre-branching legacy data, which always forces a full load.
    let parentId: string | null = null;
    for (let i = 0; i < 10; i++) {
      insertMessage(threadId, { id: `m${i}`, role: "user", kind: "text", text: `text ${i}`, at: Date.now(), parentId });
      parentId = `m${i}`;
    }

    const store = new Store(selection);
    const page = store.messagesTail(threadId, 3);
    expect(page.messages.map((m) => m.text)).toEqual(["text 7", "text 8", "text 9"]);
    expect(page.hasMore).toBe(true);
    // the bounded SQL read must not have materialized and cached the rest
    // of the transcript
    expect(store.threadIsCachedForTests(threadId)).toBe(false);

    // an explicit full read still works correctly, and now caches it
    expect(store.messagesFor(threadId)).toHaveLength(10);
    expect(store.threadIsCachedForTests(threadId)).toBe(true);
  });

  it("messagesTail caches a thread whose whole history fits in the page", () => {
    const threadId = "short-thread";
    insertMessage(threadId, { id: "a", role: "user", kind: "text", text: "one", at: Date.now(), parentId: null });
    insertMessage(threadId, { id: "b", role: "user", kind: "text", text: "two", at: Date.now(), parentId: "a" });

    const store = new Store(selection);
    const page = store.messagesTail(threadId, 5);
    expect(page.messages.map((m) => m.text)).toEqual(["one", "two"]);
    expect(page.hasMore).toBe(false);
    // nothing left to page through later, so this is cached like any
    // other full load — a later messagesFor() does not re-read it
    expect(store.threadIsCachedForTests(threadId)).toBe(true);
  });

  it("evicts the least-recently-used thread and re-reads it transparently", () => {
    const setup = new Store(selection);
    const a = setup.createBot({ name: "A" }, { seedMessages: false });
    const b = setup.createBot({ name: "B" }, { seedMessages: false });
    const c = setup.createBot({ name: "C" }, { seedMessages: false });
    setup.appendMessage(a.threadId, { role: "user", kind: "text", text: "hi a" });
    setup.appendMessage(b.threadId, { role: "user", kind: "text", text: "hi b" });
    setup.appendMessage(c.threadId, { role: "user", kind: "text", text: "hi c" });

    // a fresh Store with a bound cache starts cold regardless of what the
    // setup store above warmed — the messagesFor() calls below are what
    // actually populate this store's cache, in a controlled order
    const store = new Store(selection, { threadCacheLimit: 2 });
    expect(store.threadIsCachedForTests(a.threadId)).toBe(false);

    store.messagesFor(a.threadId);
    store.messagesFor(b.threadId);
    expect(store.threadIsCachedForTests(a.threadId)).toBe(true);
    expect(store.threadIsCachedForTests(b.threadId)).toBe(true);

    // a third thread pushes the cache past its bound; A is the least
    // recently used (touched before B) and is evicted, not B
    store.messagesFor(c.threadId);
    expect(store.threadIsCachedForTests(a.threadId)).toBe(false);
    expect(store.threadIsCachedForTests(b.threadId)).toBe(true);
    expect(store.threadIsCachedForTests(c.threadId)).toBe(true);

    // eviction is invisible to callers: A's messages re-hydrate correctly
    // from sqlite, and touching it again re-warms the cache — this time
    // evicting B, the next-least-recently-used entry
    expect(store.messagesFor(a.threadId).map((m) => m.text)).toEqual(["hi a"]);
    expect(store.threadIsCachedForTests(a.threadId)).toBe(true);
    expect(store.threadIsCachedForTests(b.threadId)).toBe(false);
  });

  it("appendMessage after eviction stays consistent with what is durable on disk", () => {
    const setup = new Store(selection);
    const target = setup.createBot({ name: "Target" }, { seedMessages: false });
    const filler = setup.createBot({ name: "Filler" }, { seedMessages: false });
    setup.appendMessage(target.threadId, { role: "user", kind: "text", text: "before eviction" });

    const store = new Store(selection, { threadCacheLimit: 1 });
    store.messagesFor(target.threadId); // warm the cache
    expect(store.threadIsCachedForTests(target.threadId)).toBe(true);
    store.messagesFor(filler.threadId); // one slot only — evicts target
    expect(store.threadIsCachedForTests(target.threadId)).toBe(false);

    // appendMessage on an evicted thread must re-hydrate from sqlite
    // (which already has "before eviction" persisted) rather than lose
    // it, then persist and cache the new message on top.
    const appended = store.appendMessage(target.threadId, { role: "bot", kind: "text", text: "after eviction" });
    expect(store.messagesFor(target.threadId).map((m) => m.text)).toEqual(["before eviction", "after eviction"]);
    expect(store.activeLeaf(target.threadId)).toBe(appended.id);

    // durable across a full restart, not just this process's cache
    const reloaded = new Store(selection);
    expect(reloaded.messagesFor(target.threadId).map((m) => m.text)).toEqual(["before eviction", "after eviction"]);
  });
});


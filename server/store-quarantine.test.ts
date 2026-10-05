// What the Store does with a bots.json or groups.json it cannot use (audit A7).
//
// The old behaviour was `try { parse } catch { start empty }`, after which the
// empty roster was the source of the next write: one bad byte became an empty
// roster on disk.  A value that parsed but was not a list was worse, because it
// threw out of the constructor and the server would not start at all.  Now the
// unusable file is moved aside (never deleted), the store starts without it,
// the state is logged and recorded for the app's banner, and the set-aside file
// keeps the roster protected across restarts.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { cleanupHoldReason, listDataFaults, resetDataFaults, rosterIsOnHold } from "./data-faults.ts";
import { resetRefusedSaveLog } from "./store-guard.ts";
import { Store } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const BOTS = join(DATA_DIR, "bots.json");
const GROUPS = join(DATA_DIR, "groups.json");

const setAside = (store: "bots.json" | "groups.json"): string[] =>
  readdirSync(DATA_DIR).filter((name) => name.startsWith(`${store}.corrupt-`)).sort();

/** Two bots and a room, written to disk, then returned as raw bytes so a test can corrupt them. */
function seedRoster() {
  const store = new Store(selection);
  const lead = store.createBot({ name: "Lead" });
  const helper = store.createBot({ name: "Helper" });
  const room = store.createGroup("Ops", [lead.id, helper.id]);
  store.flushBotsNow();
  return { lead, helper, room, bots: readFileSync(BOTS, "utf8"), groups: readFileSync(GROUPS, "utf8") };
}

describe("Store with an unusable bots.json or groups.json", () => {
  let error: MockInstance<typeof console.error>;

  beforeEach(() => {
    // saveBots() debounces behind a real timer; nothing may fire between tests.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    resetDataFaults();
    resetRefusedSaveLog();
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    error.mockRestore();
    vi.useRealTimers();
    resetDataFaults();
  });

  describe("bots.json", () => {
    it("sets truncated JSON aside byte for byte, starts empty, and says so", () => {
      const { bots } = seedRoster();
      const truncated = bots.slice(0, Math.floor(bots.length / 2));
      writeFileSync(BOTS, truncated);

      const reloaded = new Store(selection);

      expect(reloaded.bots).toEqual([]);
      const [name] = setAside("bots.json");
      expect(setAside("bots.json")).toHaveLength(1);
      expect(readFileSync(join(DATA_DIR, name!), "utf8")).toBe(truncated);
      expect(() => statSync(BOTS)).toThrow();
      expect(listDataFaults()).toEqual([
        expect.objectContaining({ file: "bots.json", kind: "set-aside", setAsideAs: name, writesRefused: false, holdsCleanup: true }),
      ]);
      const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain(BOTS);
      expect(logged).toContain(name!);
      expect(logged).toContain("Nothing was deleted");
    });

    it("does not seed a Director over the roster it just set aside", () => {
      seedRoster();
      writeFileSync(BOTS, "{ not json");
      const reloaded = new Store(selection);
      reloaded.seedIfEmpty();
      expect(reloaded.bots).toEqual([]);
    });

    it("saves new work into a fresh file and leaves the set-aside file alone", () => {
      const { bots } = seedRoster();
      const broken = bots.slice(0, 40);
      writeFileSync(BOTS, broken);
      const reloaded = new Store(selection);
      const [name] = setAside("bots.json");

      const fresh = reloaded.createBot({ name: "Fresh" });
      reloaded.flushBotsNow();

      expect(JSON.parse(readFileSync(BOTS, "utf8")).map((bot: { id: string }) => bot.id)).toEqual([fresh.id]);
      expect(readFileSync(join(DATA_DIR, name!), "utf8")).toBe(broken);
    });

    it.each([
      ["an object", "{}"],
      ["null", "null"],
      ["a string", '"text"'],
      ["a number", "42"],
      ["a boolean", "true"],
      ["a list of numbers", "[1,2]"],
      ["a list of nulls", "[null]"],
    ])("starts when the file holds %s instead of a list of bots, instead of throwing", (_label, body) => {
      writeFileSync(BOTS, body);
      const store = new Store(selection);
      expect(store.bots).toEqual([]);
      const [name] = setAside("bots.json");
      expect(readFileSync(join(DATA_DIR, name!), "utf8")).toBe(body);
      expect(listDataFaults()[0]).toMatchObject({ file: "bots.json", kind: "set-aside" });
    });

    it("sets an empty file aside rather than reading it as a first run", () => {
      writeFileSync(BOTS, "");
      const store = new Store(selection);
      store.seedIfEmpty();
      expect(store.bots).toEqual([]);
      expect(setAside("bots.json")).toHaveLength(1);
      expect(listDataFaults()[0]?.reason).toContain("empty");
    });

    it("reads a file that starts with a byte-order mark as the healthy file it is", () => {
      const { lead, helper, bots } = seedRoster();
      writeFileSync(BOTS, `﻿${bots}`);
      const reloaded = new Store(selection);
      expect(reloaded.bots.map((bot) => bot.id).sort()).toEqual([lead.id, helper.id].sort());
      expect(setAside("bots.json")).toEqual([]);
      expect(listDataFaults()).toEqual([]);
      reloaded.createBot({ name: "Third" });
      reloaded.flushBotsNow();
      expect(readFileSync(BOTS, "utf8").startsWith("﻿")).toBe(false);
    });

    it("keeps the bots it can read when a few entries are damaged, and saves the whole original aside", () => {
      const { lead, helper, bots } = seedRoster();
      const damaged = JSON.stringify([...JSON.parse(bots), null, { name: "no id" }, 7]);
      writeFileSync(BOTS, damaged);

      const reloaded = new Store(selection);

      expect(reloaded.bots.map((bot) => bot.id).sort()).toEqual([lead.id, helper.id].sort());
      const [name] = setAside("bots.json");
      expect(setAside("bots.json")).toHaveLength(1);
      expect(readFileSync(join(DATA_DIR, name!), "utf8")).toBe(damaged);
      // The live file already holds only the readable bots, so the next start does not copy the
      // same damage aside again; the copy still has everything.
      expect(JSON.parse(readFileSync(BOTS, "utf8")).map((bot: { id: string }) => bot.id).sort()).toEqual([lead.id, helper.id].sort());
      expect(listDataFaults()).toEqual([
        expect.objectContaining({ file: "bots.json", kind: "partial", omitted: 3, setAsideAs: name, writesRefused: false }),
      ]);
      resetDataFaults();
      const restarted = new Store(selection);
      expect(restarted.bots.map((bot) => bot.id).sort()).toEqual([lead.id, helper.id].sort());
      expect(setAside("bots.json")).toEqual([name]);
      expect(listDataFaults()).toEqual([]);
      reloaded.createBot({ name: "Third" });
      reloaded.flushBotsNow();
      expect(JSON.parse(readFileSync(BOTS, "utf8"))).toHaveLength(3);
      expect(readFileSync(join(DATA_DIR, name!), "utf8")).toBe(damaged);
    });

    it("loads a minimal older record without calling it damaged", () => {
      writeFileSync(BOTS, JSON.stringify([{ id: "legacy", name: "Old", threadId: "t-legacy", createdAt: 1 }]));
      const store = new Store(selection);
      expect(store.bots.map((bot) => bot.id)).toEqual(["legacy"]);
      expect(store.bots[0]?.tasks?.[0]?.threadId).toBe("t-legacy");
      expect(setAside("bots.json")).toEqual([]);
      expect(listDataFaults()).toEqual([]);
    });

    it("refuses to save over a bots.json it could not read or move, and says so", () => {
      mkdirSync(BOTS);
      writeFileSync(join(BOTS, "keep.txt"), "x");
      const store = new Store(selection);
      expect(store.bots).toEqual([]);
      expect(listDataFaults()).toEqual([
        expect.objectContaining({ file: "bots.json", kind: "unreadable", writesRefused: true }),
      ]);

      store.createBot({ name: "In Memory" });
      expect(() => store.flushBotsNow()).not.toThrow();
      expect(() => store.flushBotsNow()).not.toThrow();

      expect(statSync(BOTS).isDirectory()).toBe(true);
      expect(readFileSync(join(BOTS, "keep.txt"), "utf8")).toBe("x");
      const refusals = error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("not saving"));
      expect(refusals).toHaveLength(1);
      expect(store.bots.map((bot) => bot.name)).toEqual(["In Memory"]);
    });
  });

  describe("groups.json", () => {
    it("sets truncated JSON aside, keeps the bots, and saves new rooms to a fresh file", () => {
      const { lead, helper, groups } = seedRoster();
      const truncated = groups.slice(0, groups.length - 20);
      writeFileSync(GROUPS, truncated);

      const reloaded = new Store(selection);

      expect(reloaded.bots.map((bot) => bot.id).sort()).toEqual([lead.id, helper.id].sort());
      expect(reloaded.groups).toEqual([]);
      const [name] = setAside("groups.json");
      expect(readFileSync(join(DATA_DIR, name!), "utf8")).toBe(truncated);
      expect(listDataFaults()).toEqual([
        expect.objectContaining({ file: "groups.json", kind: "set-aside", setAsideAs: name, holdsCleanup: true }),
      ]);

      const room = reloaded.createGroup("New", [lead.id]);
      expect(JSON.parse(readFileSync(GROUPS, "utf8")).map((group: { id: string }) => group.id)).toEqual([room.id]);
      expect(readFileSync(join(DATA_DIR, name!), "utf8")).toBe(truncated);
    });

    it.each([
      ["an object", "{}"],
      ["null", "null"],
      ["a number", "7"],
      ["a list of rooms with no members", '[{"id":"g1"}]'],
    ])("starts when the file holds %s instead of a list of rooms", (_label, body) => {
      writeFileSync(GROUPS, body);
      const store = new Store(selection);
      expect(store.groups).toEqual([]);
      expect(setAside("groups.json")).toHaveLength(1);
    });

    it("sets an empty file aside, and reads a byte-order mark as healthy", () => {
      const { room, groups } = seedRoster();
      writeFileSync(GROUPS, `﻿${groups}`);
      expect(new Store(selection).group(room.id)?.name).toBe("Ops");
      expect(setAside("groups.json")).toEqual([]);

      writeFileSync(GROUPS, "");
      expect(new Store(selection).groups).toEqual([]);
      expect(setAside("groups.json")).toHaveLength(1);
    });

    it("keeps the rooms it can read when one entry is damaged", () => {
      const { room, groups } = seedRoster();
      const damaged = JSON.stringify([...JSON.parse(groups), "junk"]);
      writeFileSync(GROUPS, damaged);
      const reloaded = new Store(selection);
      expect(reloaded.groups.map((group) => group.id)).toEqual([room.id]);
      const [name] = setAside("groups.json");
      expect(readFileSync(join(DATA_DIR, name!), "utf8")).toBe(damaged);
      expect(listDataFaults()[0]).toMatchObject({ file: "groups.json", kind: "partial", omitted: 1 });
    });
  });

  describe("across restarts", () => {
    it("treats the second boot after a set-aside roster as the same incident, not a fresh install", () => {
      const { room } = seedRoster();
      writeFileSync(BOTS, '{"truncated');
      const first = new Store(selection);
      first.seedIfEmpty();
      expect(first.bots).toEqual([]);
      expect(first.group(room.id)?.memberIds).toHaveLength(2);
      const groupsBefore = readFileSync(GROUPS, "utf8");
      expect(rosterIsOnHold(DATA_DIR)).toBe(true);

      // Boot two: bots.json no longer exists, which on its own reads as a first run.
      resetDataFaults();
      const second = new Store(selection);
      second.seedIfEmpty();
      expect(second.bots).toEqual([]);
      expect(second.group(room.id)?.memberIds).toHaveLength(2);
      expect(readFileSync(GROUPS, "utf8")).toBe(groupsBefore);
      expect(cleanupHoldReason(DATA_DIR)).toContain("bots.json.corrupt-");
    });

    it("lifts the hold once the owner puts a repaired roster back", () => {
      const { lead, helper, bots } = seedRoster();
      writeFileSync(BOTS, '{"truncated');
      new Store(selection);
      const [name] = setAside("bots.json");

      writeFileSync(join(DATA_DIR, name!), bots);
      renameSync(join(DATA_DIR, name!), BOTS);

      resetDataFaults();
      const restored = new Store(selection);
      expect(restored.bots.map((bot) => bot.id).sort()).toEqual([lead.id, helper.id].sort());
      expect(rosterIsOnHold(DATA_DIR)).toBe(false);
      expect(cleanupHoldReason(DATA_DIR)).toBeNull();
      expect(listDataFaults()).toEqual([]);
    });

    it("keeps a restored roster's rooms intact while a set-aside copy is still waiting", () => {
      const { lead, helper, room, bots } = seedRoster();
      writeFileSync(join(DATA_DIR, "bots.json.corrupt-1790000000000"), "earlier incident");
      // A roster that lost a bot: the room still names it, and must keep naming it.
      writeFileSync(BOTS, JSON.stringify(JSON.parse(bots).filter((bot: { id: string }) => bot.id === lead.id)));
      const reloaded = new Store(selection);
      expect(reloaded.bots.map((bot) => bot.id)).toEqual([lead.id]);
      expect(reloaded.group(room.id)?.memberIds.sort()).toEqual([lead.id, helper.id].sort());
    });
  });

  describe("a healthy store", () => {
    it("round-trips bots, tasks, rooms, room tasks and bot-to-bot channels without a notice", () => {
      const store = new Store(selection);
      const a = store.createBot({ name: "A" });
      const b = store.createBot({ name: "B" });
      store.createTask(a.id, "Second task");
      const room = store.createGroup("Ops", [a.id, b.id]);
      store.createGroupTask(room.id, "Plan");
      const channel = store.createGroup("A and B", [a.id, b.id], true);
      store.flushBotsNow();

      const reloaded = new Store(selection);

      expect(reloaded.bots.map((bot) => bot.id).sort()).toEqual([a.id, b.id].sort());
      expect(reloaded.bot(a.id)?.tasks).toHaveLength(2);
      expect(reloaded.groups.map((group) => group.id).sort()).toEqual([room.id, channel.id].sort());
      expect(reloaded.group(room.id)?.tasks).toHaveLength(2);
      expect(setAside("bots.json")).toEqual([]);
      expect(setAside("groups.json")).toEqual([]);
      expect(listDataFaults()).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });

    it("still seeds one Director on a real first run", () => {
      const store = new Store(selection);
      store.seedIfEmpty();
      expect(store.bots.map((bot) => bot.name)).toEqual(["Director"]);
    });
  });

  it("leaves a read-only data folder's files alone", () => {
    seedRoster();
    writeFileSync(BOTS, "{ not json");
    chmodSync(DATA_DIR, 0o555);
    try {
      let writable = false;
      try {
        writeFileSync(join(DATA_DIR, "probe"), "x");
        rmSync(join(DATA_DIR, "probe"));
        writable = true;
      } catch {
        /* read-only, as intended */
      }
      if (writable) {
        // The mode is not enforced for uid 0, so the refusal was never set up.  Assert the
        // outcome that did happen instead of passing a claim this run cannot test: a writable
        // folder still quarantines the corrupt bytes rather than dropping them.
        const store = new Store(selection);
        expect(store.bots).toEqual([]);
        const [name] = setAside("bots.json");
        expect(readFileSync(join(DATA_DIR, name!), "utf8")).toBe("{ not json");
        return;
      }
      const store = new Store(selection);
      expect(store.bots).toEqual([]);
      expect(listDataFaults()[0]).toMatchObject({ file: "bots.json", writesRefused: true });
      expect(readFileSync(BOTS, "utf8")).toBe("{ not json");
    } finally {
      chmodSync(DATA_DIR, 0o755);
    }
  });

  // A delete removes data that cannot be un-deleted, and the roster edit that records it is the
  // only thing that stops the bot or room coming back on the next boot.  When the roster cannot be
  // written, the delete has to stop with it.  An unreadable store is set up here by making its own
  // path a directory, which fails the same way on every platform and whoever runs it, and the bot
  // or room is then created in memory — the only state a refused-write store can be holding.
  describe("a delete the roster cannot record", () => {
    it("keeps a room's messages when groups.json cannot be written", () => {
      const { lead, helper } = seedRoster();
      rmSync(GROUPS);
      mkdirSync(GROUPS);
      const store = new Store(selection);
      expect(listDataFaults()[0]).toMatchObject({ file: "groups.json", writesRefused: true });
      const room = store.createGroup("Ops", [lead.id, helper.id]);
      const messages = join(DATA_DIR, `messages-${room.threadId}.json`);
      writeFileSync(messages, "[]");

      expect(store.deleteGroup(room.id)).toBe(false);
      expect(store.group(room.id)?.id).toBe(room.id);
      expect(readFileSync(messages, "utf8")).toBe("[]");
    });

    it("keeps a bot's workspace when bots.json cannot be written", () => {
      seedRoster();
      rmSync(BOTS);
      mkdirSync(BOTS);
      const store = new Store(selection);
      expect(listDataFaults().find((fault) => fault.file === "bots.json")).toMatchObject({ writesRefused: true });
      const bot = store.createBot({ name: "Late" });
      const workspace = join(DATA_DIR, "workspaces", bot.id);
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "MEMORY.md"), "knows things");

      expect(store.deleteBot(bot.id)).toBe(false);
      expect(store.bot(bot.id)?.id).toBe(bot.id);
      expect(readFileSync(join(workspace, "MEMORY.md"), "utf8")).toBe("knows things");
    });

    it("still deletes both when the roster can be written", () => {
      const { lead, helper } = seedRoster();
      const store = new Store(selection);
      const room = store.createGroup("Ops", [lead.id, helper.id]);
      const messages = join(DATA_DIR, `messages-${room.threadId}.json`);
      writeFileSync(messages, "[]");

      expect(store.deleteGroup(room.id)).toBe(true);
      expect(store.group(room.id)).toBeUndefined();
      expect(existsSync(messages)).toBe(false);
      expect(store.deleteBot(lead.id)).toBe(true);
      expect(store.bot(lead.id)).toBeNull();
    });
  });
});

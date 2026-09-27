import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstTurnTitleText } from "./task-title.ts";

let home: string;
afterEach(async () => {
  if (!home) return;
  const { closeMessageDb } = await import("./message-db.ts");
  closeMessageDb();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  home = "";
});

async function newTask() {
  home = mkdtempSync(join(tmpdir(), "botfleet-delegation-title-"));
  vi.resetModules();
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  const { Store, UNTITLED_TASK } = await import("./store.ts");
  const store = new Store(() => ({ instanceId: "claude", model: "m" }));
  const bot = store.createBot();
  const task = store.createTask(bot.id)!;
  expect(task.title).toBe(UNTITLED_TASK);
  return { store, bot, task };
}

function delegate(payload: string, reason?: string) {
  return `[Delegated by @Planner, another bot in this BotFleet workspace. Do the work and reply directly.]\n\n${payload}${reason ? `\n\n[Reason: ${reason}]` : ""}`;
}

describe("first-turn task naming", () => {
  it("names a New task from the delegated payload, not its sender wrapper", async () => {
    const { store, bot, task } = await newTask();
    const title = firstTurnTitleText(delegate("Audit the release build\nCheck all targets."), "delegation");
    if (title) store.titleTaskFromFirstMessage(bot.id, title, task.threadId);
    expect(store.taskByThread(bot.id, task.threadId)?.title).toBe("Audit the release build");
  });

  it("excludes an optional reason and does not rename an already named task", async () => {
    const { store, bot, task } = await newTask();
    const title = firstTurnTitleText(delegate("Review the patch\nRun tests.", "The build failed"), "delegation");
    expect(title).toBe("Review the patch\nRun tests.");
    if (title) store.titleTaskFromFirstMessage(bot.id, title, task.threadId);
    const later = firstTurnTitleText(delegate("Something different"), "delegation");
    if (later) store.titleTaskFromFirstMessage(bot.id, later, task.threadId);
    expect(store.taskByThread(bot.id, task.threadId)?.title).toBe("Review the patch");
  });

  it("excludes routines, webhooks, and continuations while preserving manual naming", () => {
    const wrapped = delegate("Audit the release build");
    for (const source of ["schedule", "manual", "webhook", "resource"] as const) {
      expect(firstTurnTitleText(wrapped, source)).toBeUndefined();
    }
    expect(firstTurnTitleText(wrapped, "delegation", true)).toBeUndefined();
    expect(firstTurnTitleText("\n ", "delegation")).toBeUndefined();
    expect(firstTurnTitleText("Check the build", undefined)).toBe("Check the build");
  });
});

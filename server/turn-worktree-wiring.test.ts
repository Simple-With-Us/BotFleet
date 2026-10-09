import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INDEX_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
  "utf8",
);

describe("turn worktree lease wiring in server/index.ts", () => {
  it("admits at dispatch and releases on every documented end path", () => {
    expect(INDEX_SOURCE).toContain("applyTurnWorktreeAdmission");
    expect(INDEX_SOURCE).toContain("releaseTurnWorktreeLease");

    const releaseSites = [
      "releaseTurnWorktreeLease(event.threadId, worktreeBotId, settledOwner.dispatchId)",
      "releaseTurnWorktreeLease(turn.threadId, turn.botId, stalledDispatchId)",
      "void activeTurnWorktreeLeases.clearBot(b.id)",
      "releaseTurnWorktreeLease(threadId, bot.id, dispatchOwner.dispatchId)",
      "releaseTurnWorktreeLease(threadId, bot.id, roomDispatch.dispatchId)",
    ];
    for (const site of releaseSites) {
      expect(INDEX_SOURCE).toContain(site);
    }
  });
});

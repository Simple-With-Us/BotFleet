import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SIDEBAR_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Sidebar.tsx"), "utf8");
const APP_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../App.tsx"), "utf8");

describe("BotListItem click and selection reliability", () => {
  it("wraps the avatar in pointer-events-none so avatar clicks bubble cleanly", () => {
    expect(SIDEBAR_SRC).toContain('<div className="shrink-0 pointer-events-none">\n        <BotAvatar');
  });

  it("passes embedded and onActivate to RenameTitle in the bot row", () => {
    expect(SIDEBAR_SRC).toContain("onActivate={selectBot}");
    expect(SIDEBAR_SRC).toContain("embedded");
  });

  it("prevents text selection on preview and row to stop drag cancellation", () => {
    expect(SIDEBAR_SRC).toContain('select-none cursor-pointer');
    expect(SIDEBAR_SRC).toContain('truncate select-none');
  });

  it("handles pointer down and pointer up with drag threshold protection", () => {
    expect(SIDEBAR_SRC).toContain("onPointerDown=");
    expect(SIDEBAR_SRC).toContain("onPointerUp=");
    expect(SIDEBAR_SRC).toContain("onDragEnd=");
    expect(SIDEBAR_SRC).toContain("dx < 6 && dy < 6");
  });

  it("keys ChatView by bot.id in App.tsx for clean remounting on bot switch", () => {
    expect(APP_SRC).toContain("<ChatView key={bot.id} bot={bot} />");
  });
});

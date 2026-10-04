import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SIDEBAR_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Sidebar.tsx"), "utf8").replace(/\r\n/g, "\n");
const RENAME_TITLE_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "RenameTitle.tsx"), "utf8").replace(/\r\n/g, "\n");
const APP_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../App.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("BotListItem click and selection reliability", () => {
  it("wraps the avatar in pointer-events-none so avatar clicks bubble cleanly", () => {
    expect(SIDEBAR_SRC).toMatch(/<div className="[^"]*pointer-events-none[^"]*">\s*<BotAvatar/);
  });

  it("passes embedded and onActivate to RenameTitle in the bot row", () => {
    expect(SIDEBAR_SRC).toContain("onActivate={selectBot}");
    expect(SIDEBAR_SRC).toContain("embedded");
  });

  it("prevents text selection on preview and row to stop drag cancellation", () => {
    expect(SIDEBAR_SRC).toContain('select-none cursor-pointer');
    expect(SIDEBAR_SRC).toContain('truncate select-none');
  });

  it("dispatches selection from exactly one path per click (no pointerup dispatch)", () => {
    // Regression: #706 dispatched selectBot from BOTH onPointerUp and onClick,
    // so every row click selected twice.  The embedded RenameTitle calls
    // onActivate on its own click too — without its stopPropagation that made
    // three dispatches for one title click.  Click is the single path: a real
    // HTML5 drag sets isDragging and never produces a click.
    const rowStart = SIDEBAR_SRC.indexOf('aria-label={iconOnly ? bot.name');
    const rowEnd = SIDEBAR_SRC.indexOf("onContextMenu={onContextMenu}", rowStart);
    expect(rowStart).toBeGreaterThan(-1);
    expect(rowEnd).toBeGreaterThan(rowStart);
    const rowHandlers = SIDEBAR_SRC.slice(rowStart, rowEnd);
    expect(rowHandlers).not.toContain("onPointerUp");
    expect(rowHandlers).not.toContain("onPointerDown");
    const clickStart = rowHandlers.indexOf("onClick={");
    const keydownStart = rowHandlers.indexOf("onKeyDown={");
    expect(clickStart).toBeGreaterThan(-1);
    expect(keydownStart).toBeGreaterThan(clickStart);
    const clickHandler = rowHandlers.slice(clickStart, keydownStart);
    const dispatches = clickHandler.match(/selectBot\(\)/g) ?? [];
    expect(dispatches).toHaveLength(1);
    expect(rowHandlers).toContain("if (!isDragging.current)");
  });

  it("clears a cancelled drag before the next pointer click or keyboard focus", () => {
    // An HTML5 drag can end without dragend (Escape, window blur). The next
    // gesture must clear the stale flag before the row's click guard runs.
    const botStart = SIDEBAR_SRC.indexOf("const isDragging = useRef(false);");
    const botEnd = SIDEBAR_SRC.indexOf("{body}", SIDEBAR_SRC.indexOf("draggable", botStart));
    expect(botStart).toBeGreaterThan(-1);
    expect(botEnd).toBeGreaterThan(botStart);
    const botRow = SIDEBAR_SRC.slice(botStart, botEnd);
    expect(botRow).toMatch(/onPointerDown=\{\(\) => \{ isDragging\.current = false; \}\}/);
    expect(botRow).toContain("onPointerCancel={() => { isDragging.current = false; }}");
    expect(botRow).toContain("onBlur={() => { isDragging.current = false; }}");
    expect(botRow).toContain("onDragStart={(event) => {\n        isDragging.current = true;");
    expect(botRow).toContain("if (!isDragging.current)");
  });

  it("keeps the embedded RenameTitle click from bubbling into the row", () => {
    // The title activates the bot through its own onClick; if that click ever
    // bubbles, the row dispatches a second time on the same gesture.
    const embeddedStart = RENAME_TITLE_SRC.indexOf("if (embedded) {");
    expect(embeddedStart).toBeGreaterThan(-1);
    const embedded = RENAME_TITLE_SRC.slice(embeddedStart, embeddedStart + 600);
    expect(embedded).toContain("e.stopPropagation();");
    expect(embedded).toContain("onActivate?.()");
  });

  it("still guards the row click against post-drag clicks via isDragging", () => {
    expect(SIDEBAR_SRC).toContain("isDragging.current = true;");
    expect(SIDEBAR_SRC).toContain("onDragEnd=");
  });

  it("keys ChatView by bot.id in App.tsx for clean remounting on bot switch", () => {
    expect(APP_SRC).toContain("<ChatView key={bot.id} bot={bot} explicitThreadId={state.viewedThreadId || undefined} />");
  });
});

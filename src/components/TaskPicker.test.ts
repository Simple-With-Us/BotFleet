import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  TASK_PICKER_DISMISS_MS,
  TASK_RENAME_HINT,
  taskPickerPointerIntent,
  threadPickIntent,
} from "./TaskPicker";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "TaskPicker.tsx"), "utf8").replace(/\r\n/g, "\n");

describe("taskPickerPointerIntent", () => {
  it("treats a single click as switch, not rename", () => {
    expect(taskPickerPointerIntent("click", 1)).toBe("select");
    expect(taskPickerPointerIntent("click")).toBe("select");
  });

  it("does not let the click that accompanies a double-click close the row", () => {
    // HTML fires click (detail=1), click (detail=2), then dblclick. Closing
    // on the first of those unmounts the menu before rename can start.
    expect(taskPickerPointerIntent("click", 2)).toBe("ignore");
    expect(taskPickerPointerIntent("dblclick", 2)).toBe("rename");
  });

  it("starts a rename from right-click", () => {
    expect(taskPickerPointerIntent("contextmenu")).toBe("rename");
  });

  it("ignores unrelated events", () => {
    expect(taskPickerPointerIntent("mousedown")).toBe("ignore");
  });
});

describe("threadPickIntent", () => {
  it("views instead of switching while busy, when viewing is offered", () => {
    expect(threadPickIntent({ busy: true, active: false, viewing: false, canView: true })).toBe("view");
    // without a view affordance the busy gate is exactly what it was
    expect(threadPickIntent({ busy: true, active: false, viewing: false, canView: false })).toBe("none");
  });

  it("switches (activates) only when the bot is idle", () => {
    expect(threadPickIntent({ busy: false, active: false, viewing: false, canView: true })).toBe("switch");
    expect(threadPickIntent({ busy: false, active: false, viewing: true, canView: true })).toBe("switch");
    expect(threadPickIntent({ busy: false, active: false, viewing: false, canView: false })).toBe("switch");
  });

  it("returns to the active thread from a view, and otherwise leaves the active row alone", () => {
    expect(threadPickIntent({ busy: true, active: true, viewing: true, canView: true })).toBe("viewActive");
    expect(threadPickIntent({ busy: false, active: true, viewing: true, canView: true })).toBe("viewActive");
    expect(threadPickIntent({ busy: true, active: true, viewing: false, canView: true })).toBe("none");
    expect(threadPickIntent({ busy: true, active: true, viewing: true, canView: false })).toBe("none");
  });
});

describe("task picker copy", () => {
  it("advertises both gestures the row actually handles", () => {
    expect(TASK_RENAME_HINT).toContain("double-click");
    expect(TASK_RENAME_HINT).toContain("right-click");
    expect(TASK_PICKER_DISMISS_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("busy rows without a view affordance", () => {
  it("leaves a none intent alone instead of switching through the picker fallback", () => {
    // threadPickIntent already returns "none" for busy + no view; the row
    // handler must not second-guess it back into onSwitch the way the old
    // `!active && !onView` fallback did (ThreadTabs never had one).
    expect(SRC).not.toContain("!active && !onView");
    expect(SRC).toContain('else if (intent === "viewActive") onView?.(null);');
  });
});

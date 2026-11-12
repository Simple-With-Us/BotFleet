import { describe, expect, it } from "vitest";

import { isLifecycleToolTitle, lifecycleTextSaysCompleted, reconcileLifecycleToolOk } from "./lifecycle-tool.ts";

describe("lifecycle tool completion normalization", () => {
  it("recognizes known lifecycle titles", () => {
    expect(isLifecycleToolTitle("reminderChild")).toBe(true);
    expect(isLifecycleToolTitle("hookRun: failed")).toBe(true);
    expect(isLifecycleToolTitle("Bash")).toBe(false);
  });

  it("treats completion text on a failed lifecycle tool as done", () => {
    const detail = "Reminder child session main run completed.";
    expect(lifecycleTextSaysCompleted(detail, "reminderChild: failed")).toBe(true);
    expect(reconcileLifecycleToolOk(false, "reminderChild: failed", detail)).toBe(true);
  });

  it("keeps a real lifecycle failure", () => {
    expect(reconcileLifecycleToolOk(false, "hookRun: failed", "hook rejected")).toBe(false);
    expect(reconcileLifecycleToolOk(false, "reminderChild", "failed to complete the hook run")).toBe(false);
    expect(reconcileLifecycleToolOk(false, "hookRun", "completed with 2 errors")).toBe(false);
    expect(reconcileLifecycleToolOk(false, "workflow", "finished, 1 step failed")).toBe(false);
    expect(reconcileLifecycleToolOk(false, "hookRun: completed", "2 errors")).toBe(false);
  });

  it("does not treat text that says completed with errors as done", () => {
    expect(lifecycleTextSaysCompleted("completed with errors", "hookRun: completed")).toBe(false);
    expect(lifecycleTextSaysCompleted("Hook run completed with errors", "hookRun: completed")).toBe(false);
    expect(reconcileLifecycleToolOk(true, "hookRun: completed", "completed with errors")).toBe(false);
    expect(reconcileLifecycleToolOk(true, "hookRun: completed", "completed with 2 errors")).toBe(false);
    expect(reconcileLifecycleToolOk(true, "workflow", "finished with failures")).toBe(false);
    expect(reconcileLifecycleToolOk(true, "hookRun: failed", "completed with errors")).toBe(false);
    expect(reconcileLifecycleToolOk(false, "hookRun: completed with errors", "Reminder child session main run completed.")).toBe(false);
    expect(reconcileLifecycleToolOk(true, "hookRun: completed", "hook ran")).toBe(true);
    expect(reconcileLifecycleToolOk(true, "Bash", "completed with errors")).toBe(true);
  });

  it("does not upgrade a non-lifecycle tool that mentions completed", () => {
    expect(reconcileLifecycleToolOk(false, "Bash", "command completed with exit 1")).toBe(false);
    expect(reconcileLifecycleToolOk(false, "Read", "finished reading file")).toBe(false);
  });
});

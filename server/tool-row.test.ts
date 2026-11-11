import { describe, expect, it } from "vitest";

import { completedToolRow, startedToolRow } from "./tool-row.ts";

describe("the transcript row a tool step becomes", () => {
  it("keeps a helper step's parent from start through completion (jobs P0)", () => {
    const started = startedToolRow(
      { title: "Read", target: "notes.md", toolKind: "read", itemId: "helper-read-1", turnId: "turn-1", parentItemId: "task-1" },
      "Reading notes.md",
    );
    expect(started).toMatchObject({ name: "Read", itemId: "helper-read-1", turnId: "turn-1", parentItemId: "task-1" });

    const completed = completedToolRow(started, { ok: true }, 42);
    expect(completed).toEqual({
      name: "Read",
      ok: true,
      spoken: "Reading notes.md",
      target: "notes.md",
      kind: "read",
      itemId: "helper-read-1",
      turnId: "turn-1",
      parentItemId: "task-1",
      detail: undefined,
      durationMs: 42,
    });
  });

  it("leaves the bot's own steps without a parent", () => {
    const started = startedToolRow({ title: "Bash", itemId: "tu-1" }, undefined);
    expect(started.parentItemId).toBeUndefined();
    expect(completedToolRow(started, { ok: false, detail: "exit 1" }, undefined)).toMatchObject({
      name: "Bash",
      ok: false,
      detail: "exit 1",
      parentItemId: undefined,
    });
  });

  it("keeps the start's detail when the completion brings none, and names an unknown step", () => {
    expect(completedToolRow({ name: "Fetch", detail: "earlier" }, { ok: true }, 5).detail).toBe("earlier");
    expect(completedToolRow(undefined, { ok: true }, undefined).name).toBe("tool");
    expect(startedToolRow({}, undefined).name).toBe("tool");
  });

  it("uses a terminal title supplied by the engine and otherwise keeps the started title", () => {
    expect(completedToolRow({ name: "hookRun: inProgress" }, { ok: true, title: "hookRun: completed" }, 5).name)
      .toBe("hookRun: completed");
    expect(completedToolRow({ name: "hookRun: inProgress" }, { ok: true }, 5).name)
      .toBe("hookRun: inProgress");
  });

  it("redacts secret-shaped terminal titles before they replace a stored row", () => {
    const secret = "ak9999999999999999999999999999999";
    const row = completedToolRow(
      { name: "hookRun: inProgress" },
      { ok: false, title: `hookRun: failed api_key=${secret}` },
      5,
    );

    expect(row.name).toContain("redacted");
    expect(row.name).not.toContain(secret);
  });
});

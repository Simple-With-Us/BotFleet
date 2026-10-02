import { describe, expect, it } from "vitest";

import { describeRun, groupActivityRuns, nestHelperSteps, RUN_FOLD_MIN } from "./activity-runs";
import type { Message } from "@/state/store";
import type { ToolKind } from "../../shared/tool-activity";

let seq = 0;
const tool = (name: string, ok = true): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name, ok } });
/** a step with no verdict yet — `ok` absent, not `ok: undefined`, which a
 * default parameter would quietly turn back into a finished step */
const running = (name: string): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name } });
const text = (body: string): Message => ({ id: `m${++seq}`, at: seq, role: "bot", kind: "text", text: body });
/** a stretch long enough to be worth folding — steps are one line each now,
 * so a short run costs less than the fold that would hide it */
const stretch = (name: string, count = RUN_FOLD_MIN): Message[] =>
  Array.from({ length: count }, () => tool(name));

describe("groupActivityRuns", () => {
  it("folds a long stretch of consecutive tool steps into one run", () => {
    const items = groupActivityRuns(stretch("Edit"));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("run");
    expect(items[0].kind === "run" && items[0].messages).toHaveLength(RUN_FOLD_MIN);
  });

  it("leaves a stretch shorter than the fold threshold unfolded", () => {
    const items = groupActivityRuns(stretch("Edit", RUN_FOLD_MIN - 1));
    expect(items.every((item) => item.kind === "message")).toBe(true);
  });

  it("keeps text between runs, so a run never swallows what the bot said", () => {
    const items = groupActivityRuns([...stretch("Edit"), text("Now the sitemap:"), ...stretch("Write")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("leaves a lone tool step as an ordinary message", () => {
    const items = groupActivityRuns([text("hi"), tool("Edit"), text("done")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "message"]);
  });

  it("keeps a step that is still running out of the run, so live progress stays visible", () => {
    const items = groupActivityRuns([...stretch("Edit"), running("Bash")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message"]);
    expect(items[1].kind === "message" && items[1].message.tool?.name).toBe("Bash");
  });

  it("never folds a failed turn, which renders as an error not a tool run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("error: the CLI exited")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  it("keeps ordinary failed tools visible between successful runs", () => {
    const items = groupActivityRuns([...stretch("Read"), tool("Bash", false), ...stretch("Write")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("gives a run a stable id taken from its first step", () => {
    const steps = stretch("Edit");
    const items = groupActivityRuns(steps);
    expect(items[0].kind === "run" && items[0].id).toBe(`run:${steps[0].id}`);
  });

  it("does not attribute consecutive room steps from different bots to one sender", () => {
    const roomTool = (name: string, botId: string): Message => ({
      ...tool(name),
      from: { botId, name: botId, color: "blue" },
    });

    const from = (name: string, botId: string) =>
      Array.from({ length: RUN_FOLD_MIN }, () => roomTool(name, botId));

    expect(groupActivityRuns([...from("Read", "alice"), ...from("Write", "bob")]).map((item) => item.kind)).toEqual([
      "run",
      "run",
    ]);
  });

  it("keeps local calendar-day boundaries between activity runs", () => {
    const beforeMidnight = new Date(2026, 0, 1, 23, 59).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 1).getTime();
    const stepAt = (name: string, at: number): Message => ({ ...tool(name), at });

    const day = (name: string, at: number) => Array.from({ length: RUN_FOLD_MIN }, () => stepAt(name, at));

    expect(
      groupActivityRuns([...day("Read", beforeMidnight), ...day("Write", afterMidnight)]).map((item) => item.kind),
    ).toEqual(["run", "run"]);
  });
});

describe("describeRun", () => {
  /** a step the harness classified, with the thing it touched */
  const did = (name: string, kind: ToolKind, target?: string): Message => ({
    ...tool(name),
    tool: { name, ok: true, kind, target },
  });

  it("counts repeats and names the work in order of first use", () => {
    expect(describeRun([tool("Edit"), tool("Bash"), tool("Edit"), tool("Edit")])).toBe("4 steps · Edit ×3, Run");
  });

  it("names a single repeat without a multiplier", () => {
    expect(describeRun([tool("Edit"), tool("Bash")])).toBe("2 steps · Edit, Run");
  });

  it("counts two spellings of the same job once — the header names work, not tool names", () => {
    // `Edit` and `Write` are one kind; a header that listed both would imply
    // the run did two different things
    expect(describeRun([tool("Edit"), tool("Write")])).toBe("2 steps · Edit ×2");
  });

  it("keeps an unrecognised tool's own name, so the header still identifies it", () => {
    expect(describeRun([tool("mcp__slack__send"), tool("Bash")])).toBe("2 steps · mcp__slack__send, Run");
  });

  it("trims a long tail rather than running off the row", () => {
    expect(
      describeRun([tool("Edit"), tool("Bash"), tool("Grep"), tool("WebFetch"), tool("Think")]),
    ).toBe("5 steps · Edit, Run, Search +2 more");
  });

  it("names what the run touched, which is what makes it skippable", () => {
    expect(
      describeRun([
        did("read_file", "read", "~/apps/store.ts"),
        did("read_file", "read", "~/apps/view.tsx"),
      ]),
    ).toBe("2 steps · Read ×2 — store.ts, view.tsx");
  });

  it("counts the files it could not name in the header", () => {
    expect(
      describeRun([
        did("read_file", "read", "~/a.ts"),
        did("read_file", "read", "~/b.ts"),
        did("read_file", "read", "~/c.ts"),
      ]),
    ).toBe("3 steps · Read ×3 — a.ts, b.ts +1");
  });

  it("says how many steps failed, because that is the reason to open it", () => {
    expect(describeRun([tool("Edit"), tool("Bash", false)])).toBe("2 steps · Edit, Run · 1 failed");
  });
});

describe("nestHelperSteps", () => {
  const step = (id: string, itemId: string, parentItemId?: string): Message =>
    ({ id, at: ++seq, role: "bot", kind: "activity", tool: { name: "Read", ok: true, itemId, parentItemId } });

  it("moves parallel helpers' steps under the row that started each helper", () => {
    const taskA = step("a", "task-a");
    const taskB = step("b", "task-b");
    const a1 = step("a1", "a-read-1", "task-a");
    const b1 = step("b1", "b-read-1", "task-b");
    const a2 = step("a2", "a-read-2", "task-a");
    const own = step("own", "bot-read");
    const reply = text("done");
    const ordered = nestHelperSteps([taskA, taskB, a1, b1, own, a2, reply]);
    expect(ordered.map((m) => m.id)).toEqual(["a", "a1", "a2", "b", "b1", "own", reply.id]);
  });

  it("returns the same array when nothing is a helper step", () => {
    const messages = [step("x", "x-1"), text("hi")];
    expect(nestHelperSteps(messages)).toBe(messages);
  });

  it("keeps a step whose parent row is not in the window where it was", () => {
    const orphan = step("o", "o-1", "task-gone");
    const messages = [text("before"), orphan, text("after")];
    expect(nestHelperSteps(messages)).toBe(messages);
  });

  it("never drops a row from a malformed chain", () => {
    const loopA = step("la", "la-1", "lb-1");
    const loopB = step("lb", "lb-1", "la-1");
    const root = step("r", "r-1");
    const child = step("c", "c-1", "r-1");
    const ordered = nestHelperSteps([loopA, root, loopB, child]);
    expect(ordered).toHaveLength(4);
    expect(new Set(ordered.map((m) => m.id))).toEqual(new Set(["la", "lb", "r", "c"]));
    expect(ordered.indexOf(child)).toBe(ordered.indexOf(root) + 1);
  });
});

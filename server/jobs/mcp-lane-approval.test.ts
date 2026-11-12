// Owner ruling (b), and the gate that makes it reach the MCP lane (jobs P2).
//
// The ruling: a bot in full-auto mode NEVER gets a `job_start` approval card —
// not for a destructive command, not for a sensitive one, and not in a
// webhook, resource-alert, text-started or job-woken turn.  Every other bot
// gets a card for every `job_start`, and abandoning that card is a deny.
//
// The lane's job is not to re-decide the ruling but to make sure an MCP
// `job_start` is RECOGNISED as the harness's own, so the one decision that
// already exists applies to it.  Recognition is by origin: the ask must be
// open on this broker.  A mounted MCP server reports a tool by its bare name,
// so the name alone would let any third-party `job_start` claim the ruling —
// these tests pin that it does not.
import { describe, expect, it } from "vitest";

import { autoVerdict, isJobTool, isOwnJobStartRequest } from "../auto-approve.ts";
import { createPermissionBroker } from "../tools/approvals.ts";
import { JOB_SUMMARY_MAX_CHARS, harnessTool } from "../tools/registry.ts";
import type { DriverKind } from "../contracts.ts";
import type { RuntimeEvent } from "../contracts.ts";

const FULL_AUTO = {
  id: "bot_auto",
  name: "Auto",
  autoApprove: true,
  unattended: false,
  userMessagesAtTurnStart: 1,
  userMessageTimes: [],
  userMessageRecentTimes: [],
  userMessageCadence: { day: 0, week: 0, month: 0 },
  execApproval: "auto" as const,
  execAllowlist: [] as string[],
} as never;

const CAREFUL = { ...(FULL_AUTO as object), id: "bot_careful", name: "Careful", autoApprove: false, execApproval: "ask" as const } as never;

const CMD = "pnpm test";
const SUMMARY = `job: ${CMD}`;

/** A real broker, so `isOpen` is the production answer and not a stub of it. */
function broker() {
  const events: RuntimeEvent[] = [];
  const b = createPermissionBroker({ publish: (event) => events.push(event) });
  return { broker: b, events };
}

describe("a job_start over the MCP lane is the harness's own, by origin", () => {
  it("is recognised when the ask is open on this broker", async () => {
    const { broker: b, events } = broker();
    const pending = b.request({ threadId: "t", botId: "bot_careful", provider: "claudeAgent", tool: "job_start", summary: SUMMARY });
    const opened = events.find((e) => e.type === "request.opened")!;
    expect(isOwnJobStartRequest(b, opened)).toBe(true);
    b.respond("t", opened.requestId!, { behavior: "deny" });
    expect(await pending).toBe("rejected");
  });

  it("is NOT recognised for a third-party tool that borrows the name", () => {
    // This is the whole reason origin decides it: a mounted MCP server's
    // `job_start` reaches the broker over a channel that never opened here, so
    // it must not inherit the full-auto ruling.
    const { broker: b } = broker();
    expect(isOwnJobStartRequest(b, { tool: "job_start", threadId: "t", requestId: "req_from_somewhere_else" })).toBe(false);
  });

  it("is NOT recognised for another tool the harness owns", () => {
    const { broker: b, events } = broker();
    void b.request({ threadId: "t", botId: "bot_careful", provider: "claudeAgent", tool: "bash", summary: "job: x" });
    const opened = events.find((e) => e.type === "request.opened")!;
    expect(isOwnJobStartRequest(b, opened)).toBe(false);
  });

  it("does not extend the ruling to the other job tools", () => {
    // The ruling names `job_start` and nothing else.  `job_kill` is reached by
    // the ordinary grants, so for a full-auto bot it is auto mode that carries
    // it — and for a bot that is not in full auto it is a card, like any
    // other tool it has no grant for.
    const { broker: b, events } = broker();
    void b.request({ threadId: "t", botId: "bot_auto", provider: "claudeAgent", tool: "job_kill", summary: "job: pkill -f node" });
    const opened = events.find((e) => e.type === "request.opened")!;
    expect(isOwnJobStartRequest(b, opened)).toBe(false);
    expect(autoVerdict(FULL_AUTO, "job_kill", "job: pkill -f node", { ownJobStart: false }).source).toBe("auto-mode");
    expect(autoVerdict(CAREFUL, "job_kill", "job: pkill -f node", { ownJobStart: false }).approve).toBeNull();
    // `isJobTool` is the set the ruling and the `job:` card namespace key off,
    // and it is `job_start` alone — deliberately, since that is the only tool
    // this ruling is about.
    expect(isJobTool("job_start")).toBe(true);
    expect(isJobTool("job_kill")).toBe(false);
    // A namespaced MCP name is the same tool, which is why origin decides.
    expect(isJobTool("mcp__agents__job_start")).toBe(true);
  });
});

describe("a full-auto bot never gets a job_start card, on any lane", () => {
  // The contexts a turn can arrive from.  The ruling was narrowed once and the
  // owner rejected it, so every one of these must come out `null`.
  const lanes: Array<[string, Parameters<typeof autoVerdict>[3]]> = [
    ["an attended turn", {}],
    ["a webhook turn", { unattended: true }],
    ["a resource-alert turn", { unattended: true }],
    ["a text-started turn", { unattended: true }],
    ["a job's own wake", { unattended: true }],
  ];

  for (const [name, context] of lanes) {
    it(`auto-approves in ${name}`, () => {
      expect(autoVerdict(FULL_AUTO, "job_start", SUMMARY, { ...context, ownJobStart: true }).approve).not.toBeNull();
    });
  }

  it("auto-approves a destructive command and a sensitive one alike", () => {
    // The two guards that would otherwise turn this back into a card.
    expect(autoVerdict(FULL_AUTO, "job_start", "job: rm -rf /", { ownJobStart: true }).approve).not.toBeNull();
    expect(autoVerdict(FULL_AUTO, "job_start", "job: psql -c 'select 1'", { ownJobStart: true }).approve).not.toBeNull();
  });

  it("auto-approves on the MCP lane's own approval scope, which is the host", () => {
    // The lane scopes its ask `local-computer`, which is the guard that would
    // normally card a full-auto bot's host control.  The ruling stands ahead
    // of it, so a job start on the host still needs no card.
    const verdict = autoVerdict(FULL_AUTO, "job_start", SUMMARY, { ownJobStart: true, scope: "local-computer" });
    expect(verdict.approve).not.toBeNull();
    expect(verdict.source).toBe("auto-mode");
  });

  it("needs no card for a full-auto bot even when the ask did NOT come from the harness", () => {
    // A consequence of the ruling rather than a gap in it: auto mode already
    // carries an unclassified tool, so a lookalike `job_start` a third party
    // sent is auto-approved by auto mode, not by the ruling.  Pinned so the
    // difference is visible if either rule ever moves.
    const verdict = autoVerdict(FULL_AUTO, "job_start", SUMMARY, { ownJobStart: false });
    expect(verdict.approve).not.toBeNull();
    expect(verdict.source).toBe("auto-mode");
  });

  it("still guards a full-auto bot's other tools", () => {
    // The ruling is about this one tool; it must not have widened by accident.
    // Auto mode approves an unclassified tool, so the proof that the guards
    // are intact is a destructive one — the guard that never moves.
    expect(autoVerdict(FULL_AUTO, "bash", "run a test suite", {}).approve).not.toBeNull();
    const guarded = autoVerdict(FULL_AUTO, "bash", "rm -rf ~/Library", {});
    expect(guarded.approve).toBeNull();
    expect(guarded.source).toBe("destructive-guard");
  });
});

describe("every other bot gets a card for every job_start", () => {
  it("holds the card open, in every turn kind", () => {
    for (const context of [{}, { unattended: true }]) {
      expect(autoVerdict(CAREFUL, "job_start", SUMMARY, { ...context, ownJobStart: true }).approve).toBeNull();
    }
  });

  it("never lets a person approve a command the card could not show whole", () => {
    const cut = `job: ${CMD}${"y".repeat(JOB_SUMMARY_MAX_CHARS)}…`;
    // A full-auto bot's OWN job start is still auto-approved: the ruling was
    // written to stand ahead of this check on purpose, so a full-auto bot
    // never waits on a person at all.
    expect(autoVerdict(FULL_AUTO, "job_start", cut, { ownJobStart: true }).approve).not.toBeNull();
    // A lookalike that is not the harness's own is not: the cut tail is
    // unseen, so nothing but a person may approve it.
    const lookalike = autoVerdict(FULL_AUTO, "job_start", cut, { ownJobStart: false });
    expect(lookalike.approve).toBeNull();
    expect(lookalike.rule).toBe("command-needs-full-review");
  });

  it("names the job the same way the lane's card does", () => {
    // The lane builds its summary from the same helper the tool record does,
    // so a card from the MCP lane and a card from the HTTP lane read alike.
    expect(harnessTool("job_start")!.approval!.summary({ command: "pnpm test" })).toBe(SUMMARY);
  });
});

describe("the ruling is keyed to the job_start ask itself", () => {
  it("is scoped to the tool, not to the engine that carried it", () => {
    // Every mounted engine is the same decision: Codex inside its sandbox,
    // Claude, the ACP family and pi all reach this one verdict, and Antigravity
    // is judged by the same rule when its gate opens.
    const engines: DriverKind[] = ["claudeAgent", "codex", "dsh", "grokAgent", "kimi", "mcode", "cursor", "droid", "opencode", "qwen", "hermes", "deepseekAgent", "pi", "antigravityAgent"];
    for (const provider of engines) {
      const { broker: b, events } = broker();
      void b.request({ threadId: `t-${provider}`, botId: "bot_auto", provider, tool: "job_start", summary: SUMMARY });
      const opened = events.find((e) => e.type === "request.opened")!;
      expect(autoVerdict(FULL_AUTO, "job_start", SUMMARY, { ownJobStart: isOwnJobStartRequest(b, opened) }).approve).not.toBeNull();
    }
  });
});

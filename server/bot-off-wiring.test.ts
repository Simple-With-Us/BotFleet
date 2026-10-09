// An Off bot is only as off as the call sites that honor it.
//
// `bot-power.test.ts` pins the predicate and the queues, `bot-off.test.ts`
// drives the running harness.  This file pins the WIRING in `index.ts`, which
// is where a bot would quietly keep working: a new dispatch path that skips
// the gate, a gate that moves below the thing it was meant to precede, or a
// manager whose `botState` stops answering "off".  Source assertions are the
// right tool here for the same reason as `bot-stop-wiring.test.ts`: most of
// these routes live inside one enormous request handler, so a behavioral
// test only ever covers the path it happens to drive.
//
// Each assertion is an ORDER or a COUNT, never a bare "the string appears":
// the gate has to come before the thing it protects, and the set of raw
// provider dispatches has to stay the two we know about.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(SERVER_DIR, file), "utf8").replace(/\r\n/g, "\n");
const source = read("index.ts");

/** The body of one top-level function, from its signature to its closing brace. */
function functionBody(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end, `${signature} has no end`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The slice of the request handler for one route, from its match to the next match. */
function routeBody(matcher: string): string {
  const start = source.indexOf(matcher);
  expect(start, `${matcher} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("m = path.match(", start + matcher.length);
  return source.slice(start, next === -1 ? start + 12_000 : next);
}

describe("startTurn", () => {
  const body = functionBody("async function startTurn(");

  it("refuses an Off bot before the stop decision, so a refused message cannot clear a stop", () => {
    const gate = body.indexOf("if (botIsOff(bot)) throw botOffError();");
    const decision = body.indexOf("decideBotStop(");
    expect(gate).toBeGreaterThan(-1);
    expect(decision).toBeGreaterThan(gate);
    expect(body.indexOf("clearBotSnooze(")).toBeGreaterThan(gate);
  });

  it("does not let a person-initiated turn through the Off gate", () => {
    const gateLine = body.split("\n").find((line) => line.includes("botIsOff(bot)")) ?? "";
    expect(gateLine).not.toContain("personInitiated");
  });
});

describe("every raw provider dispatch is gated", () => {
  it("has exactly two adapter.sendTurn call sites: startTurn and runGroupMemberTurn", () => {
    const sites = [...source.matchAll(/\.adapter\.sendTurn\(/g)].map((match) => match.index!);
    expect(sites).toHaveLength(2);
    const startTurn = source.indexOf("async function startTurn(");
    const startTurnEnd = source.indexOf("\n}\n", startTurn);
    const member = source.indexOf("async function runGroupMemberTurn(");
    const memberEnd = source.indexOf("\n}\n", member);
    const inside = (at: number, from: number, to: number) => at > from && at < to;
    expect(sites.filter((at) => inside(at, startTurn, startTurnEnd))).toHaveLength(1);
    expect(sites.filter((at) => inside(at, member, memberEnd))).toHaveLength(1);
  });

  it("gates a room member before it queues, reloads or dispatches", () => {
    const body = functionBody("async function runGroupMemberTurn(");
    const gate = body.indexOf("if (botIsOff(bot))");
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf("providerReloadInProgress")).toBeGreaterThan(gate);
    expect(body.indexOf(".sendTurn(")).toBeGreaterThan(gate);
    // skips the member, not the round: the other responders still speak
    expect(body.slice(gate, gate + 400)).toContain("return true;");
  });
});

describe("chat ingress", () => {
  it("refuses an Off bot at the top of the messages route, before it can steer or queue", () => {
    const body = routeBody("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/messages$/);");
    const gate = body.indexOf("if (botIsOff(bot))");
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf(".steer(")).toBeGreaterThan(gate);
    expect(body.indexOf("queueSteeredMessage(")).toBeGreaterThan(gate);
    expect(body.indexOf("startTurn(")).toBeGreaterThan(gate);
    // ahead of the transport checks too, so iMessage and Linq get the same answer
    expect(body.indexOf("imessagePerBot")).toBeGreaterThan(gate);
  });

  it("refuses an edit before it forks the transcript", () => {
    const body = routeBody("m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/messages\\/([\\w-]+)\\/edit$/);");
    const gate = body.indexOf("if (botIsOff(bot))");
    expect(gate).toBeGreaterThan(-1);
    expect(body.indexOf("store.branchMessage(")).toBeGreaterThan(gate);
  });

  it("carries the code on the HTTP body so clients can tell Off from a stop", () => {
    const hits = source.match(/json\(res, 409, \{ error: BOT_OFF_REFUSAL, code: BOT_OFF_CODE \}\)/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });
});

describe("automation", () => {
  it("answers 'off' from every manager's botState, ahead of 'busy'", () => {
    const lines = source.split("\n").filter((line) => line.includes('return !bot ? "missing"'));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain('botIsOff(bot) ? "off"');
      expect(line.indexOf('"off"')).toBeLessThan(line.indexOf('"busy"'));
    }
  });

  it("never wakes an Off bot for a finished job", () => {
    const body = source.slice(source.indexOf("botHasJobTools: (botId) => {"), source.indexOf("startWake: async"));
    expect(body).toContain("if (botIsOff(bot)) return false;");
  });
});

describe("peers", () => {
  it("refuses ask_bot and delegate_bot to an Off bot before anything is queued", () => {
    const ask = functionBody("export async function executeAskBotRequest(");
    expect(ask.indexOf("botIsOff(target)")).toBeGreaterThan(-1);
    expect(ask.indexOf("botIsOff(target)")).toBeLessThan(ask.indexOf("askBotAndWait("));
    const delegate = functionBody("export function executeDelegateBotRequest(");
    expect(delegate.indexOf("botIsOff(target)")).toBeGreaterThan(-1);
    expect(delegate.indexOf("botIsOff(target)")).toBeLessThan(delegate.indexOf("queueDelegation("));
  });
});

describe("update readiness", () => {
  it("leaves an Off bot's queued work out of what holds an update, but still counts its running turn", () => {
    const body = functionBody("function currentRuntimeReadiness(");
    expect(body).toContain("queuedMessageCount(botIsOffId)");
    expect(body).toContain("_queuedRoomCount(botIsOffId)");
    expect(body).toContain("botIsOffId(item.toBotId)");
    expect(body).toContain('run.status === "queued" && botIsOffId(run.botId)');
    // `turns` is deliberately not filtered: a turn that is running is real work.
    const turnsLine = body.split("\n").find((line) => line.includes("turns:")) ?? "";
    expect(turnsLine).toContain("bot.busy");
    expect(turnsLine).not.toContain("botIsOff");
  });
});

describe("switching Off", () => {
  it("settles the bot's queued work when it turns Off, from the desktop PATCH and the paired profile PATCH", () => {
    // Both write routes, so a phone cannot switch a bot Off and leave its queues behind.
    expect(source).toContain("if (patch.off === true && existingBot?.off !== true) settleWorkForOffBot(bot.id);");
    expect(source).toContain("if (parsed.patch.off === true && existingBot.off !== true) settleWorkForOffBot(bot.id);");
    const settle = functionBody("function settleWorkForOffBot(");
    expect(settle).toContain("routines?.skipQueuedRunsForBot(botId)");
    // a running turn is left alone: the queues are only dropped for an idle bot
    expect(settle.indexOf("bot.busy")).toBeLessThan(settle.indexOf("dropQueuedForOffBot("));
    expect(settle).not.toContain("interrupt");
  });
});

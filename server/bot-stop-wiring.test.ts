// Stop is this turn — and this file pins the WIRING that keeps it that way.
//
// `server/bot-stop-policy.test.ts` pins the module surface.  This file pins
// the call sites, which is where a latch would actually come back: a snooze
// written by `interruptBot`, a stop gate growing back inside `startTurn`, a
// resume path asking whether the bot "is stopped".  A pure policy test cannot
// see any of that, and a booted-harness test only catches the one path it
// happens to drive — so these assertions read the source, in the same style
// as `bot-off-wiring.test.ts`, and they are orders and absences, never bare
// "the string appears somewhere".
//
// The contract being wired (docs/decisions/2026-11-23-stop-is-this-turn.md):
// Stop interrupts the running turn and cancels its routine runs, leaves no
// latch, and the next webhook, schedule or message runs as usual.  Off is
// the only persistent hold.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(SERVER_DIR, file), "utf8").replace(/\r\n/g, "\n");
const index = read("index.ts");
const routines = read("routines.ts");

/** The body of one top-level function, from its signature to its closing brace. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end, `${signature} has no end`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("no stop latch can grow back", () => {
  it("index.ts carries no stop state at all: no snooze consult, gate, clear or refusal", () => {
    // The retired mechanism, by name.  A reintroduction under any of these
    // names is the regression; a new name fails the routines.ts assertions
    // below instead, so neither spelling slips through.
    for (const retired of ["snoozeBot", "isBotSnoozed", "clearBotSnooze", "decideBotStop", "botStopRefusalMessage", "isBotStoppedError", "botStopErrorCode"]) {
      expect(index, `${retired} returned in index.ts`).not.toContain(retired);
    }
    expect(index).not.toContain('"bot_stopped"');
  });

  it("interruptBot still cancels the turn's routine runs — Stop is not a no-op", () => {
    const body = functionBody(index, "async function interruptBot(");
    expect(body).toContain("routines.cancelAllRunsForBot(bot.id)");
    expect(body).toContain("jobHost?.stopThread(bot.id, interruptLiveThreadId)");
  });

  it("startTurn refuses only an Off bot before dispatching, with no stop gate after it", () => {
    const body = functionBody(index, "async function startTurn(");
    const gate = body.indexOf("if (botIsOff(bot)) throw botOffError();");
    expect(gate).toBeGreaterThan(-1);
    expect(body.slice(gate)).not.toContain("bot_stopped");
  });
});

describe("the routine manager holds no bot snooze", () => {
  it("exposes no snooze methods", () => {
    for (const retired of ["snoozeBot(", "clearBotSnooze(", "clearAllBotSnoozes(", "isBotSnoozed("]) {
      expect(routines, `${retired} still defined in routines.ts`).not.toContain(retired);
    }
  });

  it("drops a legacy botSnoozes file entry on load instead of restoring it", () => {
    // The migration IS the absence of a restore: an old install's saved
    // latch must die on upgrade, or Stop keeps holding bots it no longer
    // owns.  Assert the load path mentions the field only to skip it.
    const load = routines.slice(routines.indexOf("readFileSync"), routines.indexOf("if (this.passive) {", routines.indexOf("readFileSync")));
    expect(load).not.toMatch(/disk\.botSnoozes\s*\)/);
    expect(load).not.toContain("botSnoozeUntil");
    expect(routines).not.toContain("botSnoozeUntil");
  });

  it("never persists botSnoozes again", () => {
    const save = functionBody(routines, "flushNow");
    expect(save).not.toContain("botSnoozes");
    // The wire object is explicit: adding the field back fails here even
    // under a fresh name for the map.
    expect(routines).not.toMatch(/\.\.\.\(Object\.keys\(botSnoozes\)/);
  });

  it("skips scheduled and delivered work for Off only, never for a stop", () => {
    expect(routines).not.toContain('"bot_stopped"');
    // The Off skip path survives: turning Off still halts automation.
    expect(routines).toContain("this.botIsOff(input.botId)");
    expect(routines).toContain("skipForOff");
  });
});

describe("the module only names an Off refusal", () => {
  it("bot-stop-policy.ts exports botOffError and isBotOffError and nothing else", () => {
    const policy = read("bot-stop-policy.ts");
    const exports_ = [...policy.matchAll(/^export (?:async )?(?:function|const|class|interface|type) (\w+)/gm)].map((m) => m[1]).sort();
    expect(exports_).toEqual(["botOffError", "isBotOffError"]);
  });

  it("its decision reference is a document that exists", () => {
    const policy = read("bot-stop-policy.ts");
    const cited = [...policy.matchAll(/docs\/decisions\/[\w.-]+\.md/g)].map((m) => m[0]);
    expect(cited.length).toBeGreaterThan(0);
    for (const doc of cited) {
      expect(() => read(join("..", doc)), `${doc} cited but missing`).not.toThrow();
    }
  });
});

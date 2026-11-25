// Stop is this turn; Off is the only hold (owner ruling, BF-2453).
//
// `server/bot-stop-policy.test.ts` pins the policy surface.  This file pins
// the WIRING, which is where the old stop lived two ways: a resume used to
// clear a stop while re-dispatching, and Stop used to write a snooze latch
// that held every automation until a person's next message.  The regression
// to guard against now is a latch creeping BACK: a stop decision or refusal
// in `startTurn`, or `interruptBot` writing a snooze.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
// Normalize line endings before locating the declaration/body boundaries,
// independently of whichever admission fence is the first statement.
const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8").replace(/\r\n/g, "\n");

/** The full body of `async function startTurn(`, for wiring assertions. */
function startTurnBody(text: string): string {
  const declaration = text.indexOf("async function startTurn(");
  const opening = declaration < 0 ? -1 : text.indexOf(") {\n", declaration);
  const closing = opening < 0 ? -1 : text.indexOf("\n}", opening);
  if (opening < 0 || closing < 0) throw new Error("startTurn body is missing");
  return text.slice(opening, closing);
}

/** The first 12k characters of `interruptBot(`, which cover its latch site. */
function interruptBotBody(text: string): string {
  const declaration = text.indexOf("function interruptBot(");
  if (declaration < 0) throw new Error("interruptBot is missing");
  return text.slice(declaration, declaration + 12_000);
}

describe("Stop leaves no latch", () => {
  it("has no stop decision, refusal or snooze wiring anywhere in the server entry", () => {
    // The latch these symbols implemented is gone by ruling: Stop interrupts
    // the live turn and nothing more.  Any one of them returning IS the old
    // behavior returning.
    expect(source).not.toMatch(/decideBotStop/);
    expect(source).not.toMatch(/botStopRefusalMessage/);
    expect(source).not.toMatch(/isBotStoppedError/);
    expect(source).not.toMatch(/snoozeBot\(/);
    expect(source).not.toMatch(/clearBotSnooze\(/);
    // `isBotSnoozed` stays: thread alerts and the job host still read the
    // memory-only snooze (never persisted, never set by Stop).
    expect(source).not.toMatch(/bot_stopped/);
  });

  it("still refuses an Off bot first in startTurn, ahead of any dispatch", () => {
    const body = startTurnBody(source);
    const gate = body.indexOf("if (botIsOff(bot)) throw botOffError();");
    expect(gate, "startTurn lost its Off gate").toBeGreaterThan(-1);
    expect(body.indexOf(".adapter.sendTurn(")).toBeGreaterThan(gate);
    // Off is a decision about the bot, not about who asked: a person's own
    // message must not lift it.
    const gateLine = body.split("\n").find((line) => line.includes("botIsOff(bot)")) ?? "";
    expect(gateLine).not.toContain("personInitiated");
  });

  it("keeps Stop's turn-scoped effect: interruptBot cancels the bot's routine runs", () => {
    const body = interruptBotBody(source);
    expect(body).toMatch(/cancelAllRunsForBot\(/);
    // ...and does not replace the latch it used to write.
    expect(body).not.toMatch(/snoozeBot\(/);
  });
});

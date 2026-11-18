// The chip path has to broadcast an account-level cap to the instance, and
// the matcher alone cannot prove that it does.
//
// `server/model-fallback.test.ts` pins the DECISION:  which chip text is an
// account-level cap, and that the registry turns an instance cap into a
// fallback for every bot.  This file pins the WIRING in `server/index.ts`,
// which is where the bug would live:  a decision that is computed and then
// ignored reads exactly like a working one, to a reader and to the matcher
// test, and every bot on the account keeps spending a turn to hear the same
// refusal.
//
// The shape that matters:
//   - the chip path asks the gate, and CONSUMES the answer;
//   - the account-cap branch records the cap against the instance and the
//     model, and does not also record a per-bot cooldown;
//   - the ordinary branch still records the per-bot cooldown.
//
// Verified by mutation:  deleting the `recordInstanceCap` call, or moving it
// out of the branch, fails this file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8").replace(/\r\n/g, "\n");

/** The braced body that follows an anchor. */
function bracedBody(text: string, anchor: string): string {
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found: ${anchor}`);
  const opening = text.indexOf("{", at + anchor.length - 1);
  if (opening < 0) throw new Error(`anchor has no body: ${anchor}`);
  let depth = 0;
  for (let index = opening; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(opening + 1, index);
    }
  }
  throw new Error(`anchor body is not closed: ${anchor}`);
}

const CHIP_ANCHOR = "if (quotaOrCap && textIsCandidateForQuota) {";

describe("the quota chip path broadcasts an account-level cap to the instance", () => {
  it("finds the chip path (guards against this file passing vacuously)", () => {
    const chipBody = bracedBody(source, CHIP_ANCHOR);
    expect(chipBody).toContain("quotaCooldowns");
  });

  it("asks the gate and consumes the answer", () => {
    const chipBody = bracedBody(source, CHIP_ANCHOR);
    // The decision has to be assigned, not merely called:  a bare call whose
    // result nobody reads is the shape this whole file exists to catch.
    expect(chipBody).toMatch(/const accountCap = isAccountLevelCapChip\(/);
    expect(chipBody).toMatch(/if \(accountCap\) \{/);
    // The gate needs the provider's own 402 code and the engine's driver
    // kind, so a prose mention of billing and a 429 rate limit are both
    // refused.
    expect(chipBody).toMatch(/providerErrorCode,/);
    expect(chipBody).toMatch(/registry\.get\(actualSelection\.instanceId\)\?\.driverKind/);
  });

  it("records the cap against the instance and the model, and skips the per-bot cooldown", () => {
    const chipBody = bracedBody(source, CHIP_ANCHOR);
    const capBranch = bracedBody(chipBody, "if (accountCap) {");
    // The wildcard model, because the condition is the account's and not
    // one model's.
    expect(capBranch).toMatch(
      /quotaCooldowns\.recordInstanceCap\(\s*actualSelection\.instanceId,\s*"\*",/,
    );
    expect(capBranch).not.toMatch(/recordInstanceCap\(\s*actualSelection\.instanceId,\s*actualSelection\.model,/);
    // The source the matching recovery path clears.
    expect(capBranch).toMatch(/source: ACCOUNT_CAP_SOURCE/);
    // A per-bot cooldown on top of the instance cap would cool one bot and
    // then hide the account-wide reason from the Usage view.
    expect(capBranch).not.toMatch(/quotaCooldowns\.record\(\{/);
  });

  it("does not overwrite an account row another producer owns", () => {
    const chipBody = bracedBody(source, CHIP_ANCHOR);
    const capBranch = bracedBody(chipBody, "if (accountCap) {");
    // The balance producer writes the same `*:<instance>:*` row with the
    // plan's reset window; the chip only fills it when it is empty or its own.
    expect(capBranch).toMatch(/quotaCooldowns\.get\("\*", actualSelection\.instanceId, "\*"\)/);
    expect(capBranch).toMatch(/existingAccountRow\.source === ACCOUNT_CAP_SOURCE/);
  });

  it("leaves the ordinary per-bot cooldown exactly where it was", () => {
    const chipBody = bracedBody(source, CHIP_ANCHOR);
    const elseAt = chipBody.indexOf("} else {");
    expect(elseAt, "the account-cap branch needs an else that keeps the per-bot cooldown").toBeGreaterThan(0);
    const elseBranch = bracedBody(chipBody, "} else {");
    expect(elseBranch).toMatch(/quotaCooldowns\.record\(\{/);
    expect(elseBranch).toMatch(/botId: fallbackBot\.id/);
    expect(elseBranch).toMatch(/instanceId: actualSelection\.instanceId/);
    expect(elseBranch).toMatch(/model: actualSelection\.model/);
  });
});

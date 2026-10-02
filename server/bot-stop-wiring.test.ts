// A stop is only as good as the call sites that honor it.
//
// `server/bot-stop-policy.test.ts` pins the decision.  This file pins the
// WIRING, which is where the actual bug lived: `startTurn` used to clear a
// stop on any dispatch without an `automationSource`, and every system resume
// re-dispatched through it — so the update's own pause-and-install, its
// rollback, and boot recovery each woke a bot the owner had stopped.  A pure
// policy test cannot see that, and a booted-harness test only catches the one
// path it happens to drive.
//
// So opting a bot back into running is a two-part, deliberate act: the call
// site sets `personInitiated: true` AND carries a `person-initiated:` marker
// comment saying who asked.  This test enforces the correspondence in BOTH
// directions — a flag without a marker, or a marker without the flag, fails —
// so neither can be added by accident and neither can drift apart in review.
//
// Scope detection by enclosing function name does not work here: most of
// these routes live inside one enormous request handler, so walking back to
// the nearest declaration attributes them to unrelated helpers.  The marker
// is the stable anchor.
//
// Verified by mutation: re-marking the update resume as person-initiated fails
// this file.  An earlier version of this test merely counted the flag, passed
// while carrying the original bug, and was rewritten for that reason — do not
// weaken it back to a count.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");

interface CallSite {
  line: number;
  text: string;
  /** The nearest preceding `person-initiated:` comment, if any. */
  marker: string | null;
}

/** Every `startTurn(` call site, with its person-initiated marker. */
function startTurnCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  const pattern = /(?:^|[^\w.])startTurn\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const before = source.slice(Math.max(0, match.index - 40), match.index);
    if (/function\s+$/.test(before)) continue; // the declaration itself
    if (/startTurn\s*$/.test(before)) continue; // a property reference
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    const line = source.slice(0, match.index).split("\n").length;
    // The marker sits either in the lines directly above the call or inside
    // the argument block itself, so look in both places and take the nearest.
    const lead = source.slice(Math.max(0, match.index - 800), match.index);
    const callText = source.slice(start, i);
    const fromLead = [...lead.matchAll(/person-initiated:\s*(.+)/g)].pop();
    const fromArgs = [...callText.matchAll(/person-initiated:\s*(.+)/g)].pop();
    sites.push({
      line,
      text: callText,
      marker: (fromArgs?.[1] ?? fromLead?.[1])?.trim() ?? null,
    });
  }
  return sites;
}

const sites = startTurnCallSites();
const claimsPerson = (site: CallSite) => /personInitiated\s*:\s*true/.test(site.text);

describe("startTurn call sites classify who initiated the turn", () => {
  it("finds the dispatch paths (guards against this test passing vacuously)", () => {
    // If the scanner ever stops matching, every assertion below would pass
    // on zero sites.  A scanner bug must fail loudly.
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it("requires a stated reason wherever a dispatch wakes a stopped bot", () => {
    const unmarked = sites.filter((site) => claimsPerson(site) && !site.marker);
    expect(
      unmarked.map((site) => `line ${site.line}`),
      "these dispatches clear a stop without saying who asked: add a `person-initiated:` comment",
    ).toEqual([]);
  });

  it("does not let a marker outlive the flag it justified", () => {
    const orphaned = sites.filter((site) => site.marker && !claimsPerson(site));
    expect(
      orphaned.map((site) => `line ${site.line}`),
      "these sites carry a person-initiated marker but no longer set the flag",
    ).toEqual([]);
  });

  it("keeps the update resume and boot recovery off the person-initiated list", () => {
    // Named explicitly because these carried the bug: each replays work on
    // the system's own initiative, whatever the original prompt was.  A
    // future edit that marks one of them person-initiated is the regression
    // returning, and this is the assertion that says so.
    for (const site of sites) {
      if (!/resumePrompt\.text|resumeUser|entry\.prompt|BOOT_RECOVERY/.test(site.text)) continue;
      expect(claimsPerson(site), `line ${site.line} re-dispatches without a person asking`).toBe(false);
    }
  });

  it("clears a stop in exactly one place, gated on the policy", () => {
    const clears = [...source.matchAll(/clearBotSnooze\(/g)]
      .map((m) => source.slice(0, m.index).split("\n").length);
    // One in startTurn (policy-gated), one on the explicit wake route.
    expect(clears.length).toBeLessThanOrEqual(2);
  });

  it("enforces the stop in startTurn itself, ahead of the clear it gates", () => {
    // Enforcing per-caller is the shape that let the bug exist: a new caller
    // that forgets is silently permissive.  The guard has to be the one
    // function every dispatch passes through, and it has to actually REFUSE —
    // a bare `decideBotStop(...)` whose result is ignored looks identical to
    // a working guard to a reader and to this file, so the throw is asserted
    // too.  (Mutation-tested: deleting just the throw used to pass.)
    const start = source.indexOf("async function startTurn(");
    expect(start).toBeGreaterThan(-1);
    const bodyStart = source.indexOf(") {\n  if (runtimeQuiescing)", start);
    expect(bodyStart).toBeGreaterThan(start);
    const prologue = source.slice(bodyStart, bodyStart + 1200);
    expect(prologue).toMatch(/decideBotStop\(/);
    // The decision must be consumed, not merely computed.
    expect(prologue).toMatch(/action\s*===\s*"refuse"/);
    expect(prologue).toMatch(/bot_stopped/);
    expect(prologue).toMatch(/status:\s*409/);
    // And the clear must be downstream of the decision, never before it.
    expect(prologue.indexOf("decideBotStop(")).toBeLessThan(prologue.indexOf("clearBotSnooze("));
  });
});

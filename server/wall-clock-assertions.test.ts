// A test whose expected value comes from the wall clock fails on a calendar
// boundary, not on a code change.
//
// On Oct 25, 2026 the European daylight-saving switch moved Europe/Athens
// from GMT+3 to GMT+2, and one assertion turned every required context red
// for every seat at once.  The fixture in src/lib/routine-calendar.test.ts
// left `nextRunAt` null, so the label helper read the clock itself and
// printed whichever zone abbreviation the day happened to be on.  The diff
// was innocent, so no review could have caught it: only a test that refuses
// to compare against the wall clock can.
//
// This file is that test.  It scans the test tree for four shapes that make
// an assertion follow the calendar, the host time zone or the host clock:
//
//   1. a value compared for equality against the live clock,
//   2. a date formatter built without an explicit zone,
//   3. a test that reads the host's time-zone environment variable,
//   4. a calendar helper called with the instant it needs left unset.
//
// Every needle here is assembled from parts at run time, so this guard never
// matches its own source, and the calendar shapes in rule 4 are derived from
// the production code rather than listed by hand — a new clock-substituting
// helper is picked up without anyone remembering to add it.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Needles, assembled at run time so this file never contains them. */
const CLOCK_NOW = ["Date", "now"].join(".");
const NO_ARG_DATE = ["new", "Date"].join(" ");
const FORMATTER = ["Intl", "DateTimeFormat"].join(".");
const TZ_ENV = ["process", "env", "TZ"].join(".");
const MOCKED_NOW = ["spyOn(Date,", '"now"'].join(" ");
const FAKE_TIMERS = ["useFake", "Timers"].join("");
const SYSTEM_TIME = ["setSystem", "Time"].join("");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A compared value that starts by reading the clock: either the clock
 *  function itself, or a date built with no argument at all. */
const CLOCK_ARGUMENT = new RegExp(
  `^(?:${escapeRegExp(CLOCK_NOW)}\\(|${escapeRegExp(NO_ARG_DATE)}\\(\\s*\\))`,
);

/** Bound comparisons measure a duration or check a range against a
 *  constant, so the clock they read is the thing under test and the value
 *  they produce does not move with the calendar. */
const BOUND_MATCHERS = [
  "toBeLessThan",
  "toBeGreaterThan",
  "toBeLessThanOrEqual",
  "toBeGreaterThanOrEqual",
  "toBeCloseTo",
];

const TEST_DIRECTORIES = ["server", "shared", "src", "companion", "electron", "scripts", "tests"];
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mjs|js)$/;

interface TestFile {
  path: string;
  source: string;
}

/** Every test file in the tree, read as text.  Walked by hand rather than
 *  with `import.meta.glob` so the scan has no build-time magic in it: a
 *  guard that depends on the bundler is a guard that silently scans
 *  nothing. */
function testFiles(): TestFile[] {
  const out: TestFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (["node_modules", "dist", "build", "release", ".git"].includes(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!TEST_FILE.test(entry)) continue;
      out.push({ path: full.slice(ROOT.length), source: readFileSync(full, "utf8") });
    }
  };
  for (const dir of TEST_DIRECTORIES) {
    // A tree that is not there is a tree with no tests in it.  The
    // Electron and companion directories are on their way out, and a guard
    // that hard-failed on a missing one would stop guarding anything.
    const full = join(ROOT, dir);
    if (!existsSync(full)) continue;
    walk(full);
  }
  return out;
}

/** Skip a string or template literal starting at `from`, honouring
 *  backslash escapes. */
function skipString(source: string, from: number): number {
  const quote = source[from];
  let i = from + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

/** The index of the parenthesis closing the one that opens just before
 *  `from`. */
function matchParen(source: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    i += 1;
  }
  return i - 1;
}

/** The body of a function whose opening brace sits at `from`. */
function matchBrace(source: string, from: number): string {
  let depth = 0;
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(from + 1, i);
    }
    i += 1;
  }
  return source.slice(from + 1);
}

/** Split a parameter list on its top-level commas. */
function splitParams(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < params.length) {
    const ch = params[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(params, i);
      continue;
    }
    if ("([{<".includes(ch)) depth += 1;
    else if (")]}>".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(params.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  if (params.slice(start).trim().length > 0) out.push(params.slice(start));
  return out;
}

/** Blank out comments and string bodies, keeping every offset, so a needle
 *  mentioned in prose or inside a quoted example is not read as code. */
function blankCommentsAndStrings(source: string): string {
  const out = source.split("");
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      for (let j = i; j < stop; j++) out[j] = " ";
      i = stop;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let j = i; j < stop; j++) out[j] = " ";
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const stop = skipString(source, i);
      for (let j = i; j < stop; j++) out[j] = " ";
      i = stop;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

interface ComparisonMatcher {
  name: string;
  argument: string | null;
}

interface ExpectCall {
  argument: string;
  matcher: string;
}

/** Every comparison in the file, with the compared value and the matcher
 *  chain that follows it.  Comments and string bodies are skipped, so a
 *  matcher mentioned inside a string is not mistaken for a real one. */
function expectCalls(source: string): ExpectCall[] {
  const calls: ExpectCall[] = [];
  const needle = "expect(";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (source.startsWith(needle, i)) {
      const open = i + needle.length;
      const close = matchParen(source, open);
      calls.push({ argument: source.slice(open, close), matcher: source.slice(close + 1, close + 121) });
      i = close + 1;
      continue;
    }
    i += 1;
  }
  return calls;
}

/** The matcher name and the argument it is given, from the chain that
 *  follows a comparison. */
function matcherOf(chain: string): ComparisonMatcher {
  const trimmed = chain.trimStart();
  const name = /^\.([A-Za-z]+)/.exec(trimmed);
  if (!name) return { name: "", argument: null };
  const after = trimmed.slice(name[0].length);
  if (!after.startsWith("(")) return { name: name[1], argument: null };
  const close = matchParen(trimmed, name[0].length + 1);
  return { name: name[1], argument: trimmed.slice(name[0].length + 1, close) };
}

/** Top-level arguments of a call expression, as source text. */
function callArguments(source: string, from: number, to: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = from;
  let i = from;
  while (i < to) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) {
      args.push(source.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  if (source.slice(start, to).trim().length > 0) args.push(source.slice(start, to));
  return args;
}

// ---------------------------------------------------------------------------
// The calendar shapes, read out of the production code at run time.
// ---------------------------------------------------------------------------

/** The modules whose exported functions render a calendar label.  A test
 *  that calls one of these can pick up the calendar through it. */
const CALENDAR_MODULES = ["src/lib/routine-calendar.ts", "shared/time-zone.ts"];

interface CalendarContract {
  /** Helper name -> the position of a parameter that defaults to the live
   *  clock, or -1 when it has none. */
  defaults: Map<string, number>;
  /** Helper name -> the field it fills from the live clock when the caller
   *  leaves that field unset. */
  substituted: Map<string, string>;
  /** Helpers that read the live clock in their own body, with no parameter
   *  the caller can supply the instant through. */
  direct: Set<string>;
}

function calendarContract(): CalendarContract {
  const defaults = new Map<string, number>();
  const substituted = new Map<string, string>();
  const direct = new Set<string>();
  const clockDefault = `= ${CLOCK_NOW}()`;
  const clockRead = new RegExp(`${escapeRegExp(CLOCK_NOW)}\\(\\)`, "g");
  const substitution = new RegExp(
    `([A-Za-z_$][\\w$]*)\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*(?:\\?\\?|\\|\\|)\\s*${escapeRegExp(CLOCK_NOW)}\\(\\)`,
    "g",
  );
  const declaration = /export\s+function\s+([A-Za-z_$][\w$]*)/g;

  for (const relative of CALENDAR_MODULES) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    for (let match = declaration.exec(source); match; match = declaration.exec(source)) {
      const name = match[1];
      const open = source.indexOf("(", declaration.lastIndex);
      if (open === -1) continue;
      const close = matchParen(source, open + 1);
      const params = splitParams(source.slice(open + 1, close));
      const braceAt = source.indexOf("{", close);
      if (braceAt === -1) continue;
      const body = matchBrace(source, braceAt);
      defaults.set(name, params.findIndex((param) => param.includes(clockDefault)));
      for (const found of body.matchAll(substitution)) substituted.set(name, found[2]);
      // A clock read that is part of a substitution is the caller's to pin,
      // so only the ones left over count as the helper's own.
      const own = body.replace(substitution, "");
      if (clockRead.test(own)) direct.add(name);
      clockRead.lastIndex = 0;
    }
  }
  return { defaults, substituted, direct };
}

const CONTRACT = calendarContract();

/** Does this file pin the clock?  Fake timers, a set system time, or a
 *  mocked clock function all count. */
function pinsTheClock(source: string): boolean {
  return (
    source.includes(FAKE_TIMERS) ||
    source.includes(SYSTEM_TIME) ||
    source.includes(MOCKED_NOW)
  );
}

// ---------------------------------------------------------------------------
// The rules.
// ---------------------------------------------------------------------------

interface Violation {
  path: string;
  detail: string;
}

/** Rule 1 — a value compared for equality against the live clock.
 *
 *  A file that pins the clock for its own tests is under its own control:
 *  the same convention src/lib/quota-display.test.ts and
 *  src/lib/usage-monitor-quota.test.ts already use. */
function liveClockCompared(file: TestFile): Violation[] {
  if (pinsTheClock(file.source)) return [];
  const violations: Violation[] = [];
  for (const call of expectCalls(file.source)) {
    const matcher = matcherOf(call.matcher);
    if (BOUND_MATCHERS.includes(matcher.name)) continue;
    const actual = call.argument.trim();
    const expected = (matcher.argument ?? "").trim();
    const actualIsClock = CLOCK_ARGUMENT.test(actual);
    const expectedIsClock = expected.length > 0 && CLOCK_ARGUMENT.test(expected);
    if (!actualIsClock && !expectedIsClock) continue;
    violations.push({
      path: file.path,
      detail: `compares for equality against the live clock: expect(${actual.slice(0, 60)})`,
    });
  }
  return violations;
}

/** Rule 2 — a date formatter built without an explicit zone, so its output
 *  follows the host's time zone. */
function formatterWithoutZone(file: TestFile): Violation[] {
  const violations: Violation[] = [];
  const code = blankCommentsAndStrings(file.source);
  let i = 0;
  for (;;) {
    const at = code.indexOf(FORMATTER, i);
    if (at === -1) break;
    const open = code.indexOf("(", at);
    if (open === -1) break;
    const close = matchParen(code, open + 1);
    const args = code.slice(open + 1, close);
    i = close + 1;
    if (args.includes("timeZone")) continue;
    // Asking for the host's own zone is a deliberate question, not a
    // formatting that drifts; the answer is compared with what production
    // picked on the same host.
    if (args.trim() === "" && code.slice(close + 1).trimStart().startsWith(".resolvedOptions")) continue;
    violations.push({
      path: file.path,
      detail: `builds a formatter with no explicit zone: ${file.source.slice(at, close + 1).slice(0, 80)}`,
    });
  }
  return violations;
}

/** Rule 3 — a test that reads the host's time-zone environment variable, so
 *  its result depends on where the runner happens to be. */
function readsHostZone(file: TestFile): Violation[] {
  if (!blankCommentsAndStrings(file.source).includes(TZ_ENV)) return [];
  return [{ path: file.path, detail: "reads the host's time-zone environment variable" }];
}

/** Rule 4 — a calendar helper called with the instant it needs left unset.
 *
 *  Three ways that happens: the helper has a parameter that defaults to the
 *  live clock and the caller omits it, the helper fills a field the caller
 *  left null with the live clock, or the helper reads the clock in its own
 *  body with nothing the caller can supply.  Either way the label follows
 *  the day the test happens to run on, which is what broke the gate on
 *  Oct 25, 2026. */
function calendarHelperReadsTheClock(file: TestFile): Violation[] {
  const violations: Violation[] = [];
  const source = file.source;
  const needsPin: string[] = [];

  for (const [name, clockPosition] of CONTRACT.defaults) {
    const needle = `${name}(`;
    let i = 0;
    for (;;) {
      const at = source.indexOf(needle, i);
      if (at === -1) break;
      i = at + needle.length;
      // Skip the helper's own definition.
      if (source.slice(Math.max(0, at - 12), at).includes("function ")) continue;
      const open = at + needle.length;
      const close = matchParen(source, open);
      const args = callArguments(source, open, close);
      i = close + 1;
      if (clockPosition >= 0 && args.length <= clockPosition) {
        violations.push({
          path: file.path,
          detail: `calls ${name}() without the instant it needs, so the label follows the live clock`,
        });
        continue;
      }
      const field = CONTRACT.substituted.get(name);
      if (field) {
        const unset = new RegExp(`\\b${escapeRegExp(field)}\\s*:\\s*(?:null|undefined)`);
        if (unset.test(source)) needsPin.push(`${name}() while ${field} is left unset`);
      }
      if (CONTRACT.direct.has(name)) needsPin.push(`${name}() reads the clock itself`);
    }
  }

  if (needsPin.length > 0 && !pinsTheClock(source)) {
    for (const detail of needsPin) {
      violations.push({
        path: file.path,
        detail: `${detail} — pin the clock in this file (fake timers, a set system time, or a mocked clock)`,
      });
    }
  }
  return violations;
}

const RULES: Array<{ name: string; check: (file: TestFile) => Violation[] }> = [
  { name: "a value compared for equality against the live clock", check: liveClockCompared },
  { name: "a formatter built with no explicit zone", check: formatterWithoutZone },
  { name: "a read of the host's time-zone environment variable", check: readsHostZone },
  { name: "a calendar helper called with the instant it needs left unset", check: calendarHelperReadsTheClock },
];

describe("wall-clock independence of the test tree", () => {
  const files = testFiles();

  it("finds the test files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.path.endsWith("src/lib/routine-calendar.test.ts"))).toBe(true);
  });

  for (const rule of RULES) {
    it(`has no test with ${rule.name}`, () => {
      const violations = files.flatMap(rule.check);
      expect(violations.map((violation) => `${violation.path}: ${violation.detail}`)).toEqual([]);
    });
  }
});

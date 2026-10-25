// The provider reload fence must be declared before anything that can read it.
//
// `server/index.ts` keeps the fence's state in four module-scope `let`
// bindings: `providerReloadChain`, `pendingProviderReloads`,
// `providerReloadInProgress` and `providerReloadGeneration`.  `startTurn`
// reads one of them before its first `await`, and `startTurn` is reachable
// while the module is still being evaluated: the top-level `jobHost.boot()`
// resumes the durable job runtime, and boot dispatches a queued assignment
// SYNCHRONOUSLY.
//
// A `let` is dead until its declaration has run.  With the fence declared
// further down the module, that read landed in the temporal dead zone and
// threw `Cannot access 'providerReloadInProgress' before initialization`.
// It surfaced as `provider_error` on the assignment being dispatched, so the
// turn was killed with nothing but that one error to show for it.
//
// `tsc` cannot see this.  The read sits in a function body reached through a
// call graph that starts at module evaluation, so there is no ordering for
// the compiler to complain about — it has to be pinned by a test.
//
// So this file pins two things:
//   1. the REACHABILITY — boot really does reach `startTurn` synchronously,
//      which is what makes the order matter at all; and
//   2. the ORDER — the fence is declared above every top-level side effect
//      in the module.
//
// The mutation this file is written against is moving the fence back down.
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createJobHost, type JobHost, type JobHostDeps } from "./job-host.ts";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
// Normalise line endings before matching.  A source-invariant test must not
// depend on how the runner checked the repo out: without this, an assertion
// anchored on an exact `\n` fails on a CRLF checkout.
const source = readFileSync(join(SERVER_DIR, "index.ts"), "utf8").replace(/\r\n/g, "\n");
const lines = source.split("\n");

const selection = { instanceId: "claude", model: "claude-sonnet-5" };

/** The bindings that hold the fence's state.  Each is read by `startTurn`,
 *  which a boot can reach while the module is still evaluating. */
const FENCE_BINDINGS = [
  "providerReloadChain",
  "pendingProviderReloads",
  "providerReloadInProgress",
  "providerReloadGeneration",
] as const;

/** The line a module-scope binding is declared on, or 0 when it is not
 *  declared at module scope at all. */
function declarationLine(binding: string): number {
  const index = lines.findIndex((text) => new RegExp(`^let ${binding}\\b`).test(text));
  return index + 1;
}

/** Every module-scope call statement: a line at column 0 that opens a call.
 *
 *  These are the statements that run while the module is still being
 *  evaluated, so a binding read from inside one of them — or from anything
 *  they call synchronously — is read before its declaration when the
 *  declaration sits further down the file.
 *
 *  A module-scope `await` counts as one of them: it is a top-level effect
 *  that runs while the module evaluates, and it is the one most easily
 *  missed, because the call after the keyword is what looks like the
 *  statement.  `await infisical.preload();` is a top-level effect, so the
 *  fence has to be above it. */
function topLevelCalls(): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  lines.forEach((text, index) => {
    if (!/^(?:await\s+)?[A-Za-z_$][\w$.]*\(/.test(text)) return;
    found.push({ line: index + 1, text: text.trim() });
  });
  return found;
}

/** Every module-scope `await` expression, found independently of the call
 *  detector above so the two can be cross-checked against each other. */
function moduleScopeAwaits(): Array<{ line: number; text: string }> {
  const found: Array<{ line: number; text: string }> = [];
  lines.forEach((text, index) => {
    if (!/^await\s/.test(text)) return;
    found.push({ line: index + 1, text: text.trim() });
  });
  return found;
}

describe("the provider reload fence is reachable while the module evaluates", () => {
  const hosts: JobHost[] = [];

  afterEach(() => {
    for (const host of hosts.splice(0)) host.close();
    // The message database is a process-wide handle, and it has to close
    // before this directory goes: a directory that still holds an open
    // database cannot be removed on Windows.
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  function hostFor(store: Store, starts: string[]): JobHost {
    const deps: JobHostDeps = {
      store,
      commsBus: { store, broadcast: () => {} },
      approvalBus: { store, broadcast: () => {} },
      // The body of an async function runs synchronously up to its first
      // `await`, so the push below happens inside the dispatch itself.
      startTurn: async (botId) => {
        starts.push(botId);
      },
      subscribe: () => () => {},
      snoozed: () => false,
      unattended: () => false,
    };
    const host = createJobHost(deps);
    hosts.push(host);
    return host;
  }

  it("dispatches a queued assignment to startTurn before boot() returns", () => {
    const starts: string[] = [];

    // First process: a handoff is queued, and the process ends before the
    // requester's turn settles, so the child assignment is still queued on
    // disk when the next process starts.
    const storeA = new Store(() => selection);
    const from = storeA.createBot({ name: "Asker" }, { seedMessages: false });
    const target = storeA.createBot({ name: "Helper" }, { seedMessages: false });
    const hostA = hostFor(storeA, starts);
    const handed = hostA.coordinate({
      fromBotId: from.id,
      fromThreadId: from.threadId,
      botIds: [target.id],
      message: "pick this up after the restart",
      depth: 0,
    });
    expect(handed.status).toBe(200);
    expect(starts).toEqual([]);

    // The roster is saved on a debounce, so the next process has to find it
    // on disk — exactly what a restart does.
    storeA.flushBotsNow();

    // Second process: boot resumes the runtime and dispatches the queued
    // assignment.  `boot()` is synchronous, so a dispatch that had to wait
    // for a microtask would still be pending at the next line.
    const storeB = new Store(() => selection);
    const hostB = hostFor(storeB, starts);
    hostB.boot();
    expect(starts).toEqual([target.id]);
  });
});

describe("the provider reload fence is declared above every top-level effect", () => {
  it("finds the module's top-level calls (guards against a vacuous pass)", () => {
    const calls = topLevelCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((call) => call.text.startsWith("jobHost.boot()"))).toBe(true);
  });

  it("sees every module-scope await as a top-level effect", () => {
    // A module-scope `await` is a top-level effect, and it is the easiest one
    // for the detector above to miss, because the call after the keyword is
    // what looks like the statement.  Cross-check the two independently so a
    // future edit to the detector cannot quietly narrow the rule.
    const calls = topLevelCalls();
    const awaits = moduleScopeAwaits();
    // Guards against a vacuous pass: if the await detector ever stops
    // matching, the loop below never runs and this test would prove
    // nothing.  The sibling test guards its own detector the same way.
    expect(awaits.length).toBeGreaterThan(0);
    for (const awaited of awaits) {
      expect(
        calls.some((call) => call.line === awaited.line),
        `module-scope await on line ${awaited.line} is not detected as a top-level effect`,
      ).toBe(true);
    }
  });

  it("declares the fence above the boot that resumes the job runtime", () => {
    const bootLine = lines.findIndex((text) => text.trim() === "jobHost.boot();") + 1;
    expect(bootLine).toBeGreaterThan(0);
    for (const binding of FENCE_BINDINGS) {
      const declared = declarationLine(binding);
      expect(declared, `${binding} is not declared at module scope`).toBeGreaterThan(0);
      expect(declared, `${binding} is declared after jobHost.boot()`).toBeLessThan(bootLine);
    }
  });

  it("declares the fence above every top-level call in the module", () => {
    // The general form of the same rule: nothing that runs while the module
    // evaluates may sit above the fence, so no future ordering can bite.
    const calls = topLevelCalls();
    for (const binding of FENCE_BINDINGS) {
      const declared = declarationLine(binding);
      expect(declared, `${binding} is not declared at module scope`).toBeGreaterThan(0);
      const before = calls.filter((call) => call.line < declared);
      expect(
        before.map((call) => `line ${call.line}: ${call.text}`),
        `${binding} is declared after a top-level call that can read it`,
      ).toEqual([]);
    }
  });
});

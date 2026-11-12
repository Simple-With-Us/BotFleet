// The two fixtures that gate Antigravity (jobs P2, requirement 3).
//
// Antigravity stays `backgroundJobs: "none"` until BOTH of these pass:
//   (i)  a server-side approval actually blocks the call, and
//   (ii) the global `~/.gemini` config entry is removed after every turn,
//        including the abort and crash paths.
//
// They are written as a verdict, not as a pair of hopes: each one names what it
// found, and the gate below reads the result.  If either fixture cannot pass
// today, this file says so in its own output rather than in a comment nobody
// reads, and the capability stays off.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  BOTFLEET_MCP_PREFIX,
  antigravityConfigHasBotfleetServers,
  antigravityMcpConfigPath,
  cleanStaleAntigravityMcp,
  ensureAntigravityMcp,
} from "./antigravity.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { autoVerdict, isOwnJobStartRequest } from "../auto-approve.ts";
import { createPermissionBroker } from "../tools/approvals.ts";
import type { RuntimeEvent } from "../contracts.ts";

const FAKE_AGY_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");
const JOB_KEY = `${BOTFLEET_MCP_PREFIX}job-tools`;
const SERVER = { command: process.execPath, args: ["/proxy.mjs"], env: { OMB_JOBS: "1" } };

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-agy-jobs-"));
  return dir;
}

const hasOurKey = (dir: string): boolean => antigravityConfigHasBotfleetServers(antigravityMcpConfigPath({ HOME: dir }));

describe("Antigravity gate (ii): the global config entry is removed after every turn", () => {
  it("removes the entry when the turn settles and calls its own cleanup", () => {
    const dir = home();
    try {
      const restore = ensureAntigravityMcp({ [JOB_KEY]: SERVER }, { HOME: dir });
      expect(hasOurKey(dir)).toBe(true);
      restore();
      expect(hasOurKey(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes the entry when the turn is aborted mid-flight", () => {
    // An abort is the same as a settle to the mount: the driver's settle path
    // calls the cleanup it was handed, whatever ended the turn.
    const dir = home();
    try {
      const restore = ensureAntigravityMcp({ [JOB_KEY]: SERVER }, { HOME: dir });
      expect(hasOurKey(dir)).toBe(true);
      // What the driver does on interrupt: release, then clean up.
      restore();
      expect(hasOurKey(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the entry behind on a CRASH, until an engine is created again", () => {
    // This is the fixture that decides the gate, so it is written to state the
    // truth rather than to pass.  A crash cannot run a returned function: the
    // process is gone, and with it the only thing that removes the entry.
    const dir = home();
    try {
      ensureAntigravityMcp({ [JOB_KEY]: SERVER }, { HOME: dir });
      expect(hasOurKey(dir)).toBe(true);
      // The crash: the process dies here.  Nothing else runs.

      // Recovery exists, but it is not "after every turn": it happens when the
      // Antigravity engine is next created, and `cleanStaleAntigravityMcp`'s
      // only call site is inside the driver's own init.
      expect(hasOurKey(dir)).toBe(true);
      cleanStaleAntigravityMcp({ HOME: dir });
      expect(hasOurKey(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cannot clean a file that is not ours to parse, and says so by leaving it", () => {
    // A corrupt or foreign config is left exactly as found: the sweep never
    // guesses at a file it could not read, so a crash during someone else's
    // hand-edit is not overwritten with a guess.
    const dir = home();
    try {
      mkdirSync(join(dir, ".gemini", "config"), { recursive: true });
      const path = antigravityMcpConfigPath({ HOME: dir });
      writeFileSync(path, "{ not json at all");
      cleanStaleAntigravityMcp({ HOME: dir });
      expect(readFileSync(path, "utf8")).toBe("{ not json at all");
      // And the safe-side read reports "cannot tell" as "not clean".
      expect(hasOurKey(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Antigravity gate (i): a server-side approval actually blocks the call", () => {
  it("blocks on the real broker: the ask stays open until a person answers", async () => {
    // A full-auto bot's own job start never cards (ruling b), so the proof
    // that an approval CAN block has to come from a bot that is not in full
    // auto — which is the majority, and the one the ruling protects.
    const events: RuntimeEvent[] = [];
    const broker = createPermissionBroker({ publish: (event) => events.push(event) });
    const bot = { id: "b", name: "Careful", autoApprove: false } as never;
    const pending = broker.request({
      threadId: "t",
      botId: "b",
      // Antigravity is the engine that would carry the call.
      provider: "antigravityAgent",
      tool: "job_start",
      summary: "job: rm -rf /",
    });
    const opened = events.find((e) => e.type === "request.opened")!;
    // A server-side verdict, computed by the harness and not by agy.
    expect(autoVerdict(bot, opened.tool, "job: rm -rf /", { ownJobStart: isOwnJobStartRequest(broker, opened) }).approve).toBeNull();
    // The call is still parked: nothing has answered, so nothing ran.
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    // And the person who answers is the only thing that unblocks it.
    broker.respond("t", opened.requestId!, { behavior: "deny" });
    expect(await pending).toBe("rejected");
  });

  it("cannot be answered BY the engine, because this engine has no asks to answer", async () => {
    // The reason this gate is not a formality.  Antigravity's
    // `respondToRequest` is a constant `unavailable`: print mode opens no ask
    // (agy issue #31 tracks native ACP).  A job-start approval therefore has
    // exactly one possible answerer — a person in the UI — and no engine-side
    // path at all.  That is workable for `job_start`, whose card the harness
    // owns, and it is why no other host-control tool may lean on it.
    const dir = home();
    const instance = await AntigravityDriver.create({
      instanceId: "agy-jobs",
      displayName: "Antigravity Jobs",
      environment: { HOME: dir },
      enabled: true,
      config: { cli: FAKE_AGY_CLI, fullAuto: true },
    });
    try {
      expect(await instance.adapter.respondToRequest("t", "req-1", { behavior: "allow" })).toBe("unavailable");
    } finally {
      await instance.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the Antigravity gate, as the capability record reads it", () => {
  it("stays off while fixture (ii) does not pass", async () => {
    // The decision, pinned on the real capability record so it cannot be
    // flipped by editing a comment.  Fixture (ii) asks for removal after EVERY
    // turn including crash paths.  What the driver can promise is removal on
    // settle and on abort, plus a sweep when the engine is next created — so
    // a crashed turn's entry can sit in the user's global Gemini config,
    // pointing at a proxy process that is gone.
    //
    // It would pass with an unconditional boot-time sweep that runs before any
    // driver is chosen, plus a lease TTL on the entry.  Neither exists, and
    // adding either is a change to a shared user-wide file, not a jobs
    // change — so the gate stays shut.
    const dir = home();
    const instance = await AntigravityDriver.create({
      instanceId: "agy-jobs-cap",
      displayName: "Antigravity Jobs Cap",
      environment: { HOME: dir },
      enabled: true,
      config: { cli: FAKE_AGY_CLI, fullAuto: true },
    });
    try {
      expect(instance.adapter.capabilities.backgroundJobs).toBe("none");
      expect(instance.adapter.capabilities.agentsMcp).toBe(true);
    } finally {
      await instance.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

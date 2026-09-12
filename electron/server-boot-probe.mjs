// Kernel of the packaged-server boot wait (see issue #506): poll a freshly
// forked child's /api/health until it either proves its identity, we learn
// some other process owns the port, or the wall-clock budget runs out.
//
// Extracted from electron/main.mjs so the failure modes below can carry
// regression tests without booting Electron (main.mjs is not importable in a
// bare node test — importing it starts the whole app bootstrap).
//
// - The budget is wall-clock and shared by every step: each in-flight probe is
//   aborted at the remaining deadline, so a server that accepts connections
//   but never answers cannot wedge the launcher past its own timeout.
// - ANY HTTP answer on the port proves somebody owns it. Only our own child's
//   identity payload counts as ready; everything else (a 404/503 from an
//   unrelated app, wrong pid, non-JSON body) is reported as a foreign owner
//   immediately instead of burning the rest of the budget re-polling a port
//   we will never win.
// - The expected pid must be read as a GETTER at response time, not captured
//   when the caller forks: Electron's utilityProcess assigns proc.pid on the
//   async `spawn` event, so a value grabbed right after fork() is still
//   undefined and our own freshly-bound child would fail the identity match
//   and be reaped as a "foreign owner" on its very first health answer.

import { randomBytes } from "node:crypto";
import { verifyHarnessOwnerProof } from "./harness-ownership.mjs";
import { buildCompatibility } from "./runtime-identity.mjs";

export const BOOT_PROBE_INTERVAL_MS = 500;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   port: number,
 *   pid: () => number | undefined,
 *   bootTimeoutMs: number,
 *   isExited?: () => boolean,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<{ outcome: "ready" | "foreign-owner" | "timeout" | "exited" }>}
*/
export async function pollServerIdentity({
  port,
  pid,
  bootTimeoutMs,
  isExited = () => false,
  now = Date.now,
  sleep = defaultSleep,
  fetchImpl = globalThis.fetch,
}) {
  const startedAt = now();
  const deadline = startedAt + bootTimeoutMs;
  for (;;) {
    if (isExited()) return { outcome: "exited" };
    const remainingMs = Math.max(0, deadline - now());
    if (remainingMs <= 0) return { outcome: "timeout" };

    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(remainingMs),
      });
    } catch {
      // Not up yet, or this probe ran into the wall-clock budget — either way
      // back off to the poll interval, then let the loop condition decide.
      await sleep(Math.min(BOOT_PROBE_INTERVAL_MS, Math.max(1, deadline - now())));
      continue;
    }
    const body = await res.json().catch(() => null);
    // Body consumption is covered by the same abort signal as fetch. If it
    // reaches the deadline, a null body means the probe timed out—not that a
    // different process answered on the port.
    if (now() >= deadline) return { outcome: "timeout" };
    // Read the expected pid NOW, after the response landed: until the child's
    // `spawn` event fires the getter yields undefined, and a child that has
    // not spawned cannot be the one answering — so an answer during that
    // window is genuinely somebody else's.
    const expectedPid = pid();
    const identified =
      res.ok &&
      expectedPid !== undefined &&
      body?.app === "botfleet" &&
      body.pid === expectedPid &&
      body.static;
    if (!identified) return { outcome: "foreign-owner" };
    // A response that finishes after the budget must not count as a healthy
    // boot — re-check the clock before declaring victory.
    if (now() >= deadline) return { outcome: "timeout" };
    return { outcome: "ready", latencyMs: now() - startedAt };
  }
}

// ---------------------------------------------------------------------------
// Attach-or-spawn (harness-ops, 2026-09-02).
//
// A Mac that runs the always-on launchd harness (`com.jay.botfleet-server`)
// already has a BotFleet server on 8799 when the desktop app starts. The old
// boot loop treated that as a "foreign owner" (pid mismatch), fell through to
// 18799 and forked a SECOND harness against the same ~/.botfleet data dir —
// two writers, no lock, routines firing twice. The rule is now:
//
//   - production attachment requires a live data-root owner and a valid
//     challenge proof (no child is forked, and we never kill it on quit);
//   - a port that answers with anything else is a foreign owner — skip it;
//   - a port that refuses connections is free only after every candidate has
//     been checked and no live owner or ambiguous listener prevents spawning.
//
// The probe is a single bounded request, not the child-identity poll above:
// we are asking "is anybody home", not "is my child up yet".

export const HARNESS_PROBE_TIMEOUT_MS = 2_000;
// A quit-and-reopen relaunch can find the previous instance's child still
// answering during teardown. Re-probe after a short settle before trusting an
// existing harness, so we attach to something that will still be there.
export const ATTACH_SETTLE_MS = 1_500;

/**
 * @param {{ port: number, owner?: import("./harness-ownership.mjs").HarnessOwner | null, expectedBuild?: import("./runtime-identity.mjs").BuildIdentity, timeoutMs?: number, fetchImpl?: typeof fetch }} options
 * @returns {Promise<
 *   | { kind: "none" }
 *   | { kind: "foreign" }
 *   | { kind: "unavailable" }
 *   | { kind: "botfleet", pid: number, static: boolean, sourceCommit?: string, apiVersion?: number }
 * >}
 */
export async function probeHarness({
  port,
  owner = null,
  expectedBuild,
  timeoutMs = HARNESS_PROBE_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  let res;
  const challenge = owner ? randomBytes(32).toString("hex") : undefined;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      signal,
      ...(challenge ? { headers: { "x-botfleet-owner-challenge": challenge } } : {}),
      redirect: "error",
    });
  } catch (error) {
    // Only an explicit refused connection proves the port is free.  A slow,
    // reset, or partially responding listener may still own the entire fleet.
    return { kind: error?.code === "ECONNREFUSED" || error?.cause?.code === "ECONNREFUSED" ? "none" : "unavailable" };
  }
  let body;
  try { body = await res.json(); } catch { return { kind: "unavailable" }; }
  if (owner && (body?.pid !== owner.pid || !verifyHarnessOwnerProof(owner, challenge, body?.ownerProof))) {
    return { kind: "unavailable" };
  }
  if (res.ok && body?.app === "botfleet" && Number.isInteger(body.pid)) {
    if (expectedBuild) {
      // Never send the private nonce until the health challenge proved the
      // recipient owns this data root.  Redirects cannot forward credentials.
      if (!owner) return { kind: "unavailable" };
      let runtime;
      try {
        const response = await fetchImpl(`http://127.0.0.1:${port}/api/runtime`, {
          signal, redirect: "error", headers: { authorization: `Bearer ${owner.nonce}` },
        });
        if (!response.ok) return { kind: "unavailable" };
        runtime = await response.json();
      } catch { return { kind: "unavailable" }; }
      if (runtime?.pid !== owner.pid || runtime?.dataOwner?.pid !== owner.pid ||
          runtime?.dataOwner?.port !== port) return { kind: "unavailable" };
      const compatibility = buildCompatibility(expectedBuild, runtime);
      if (compatibility === "incompatible") return { kind: "unavailable" };
      return {
        kind: "botfleet", pid: body.pid,
        static: Boolean(body.static) && compatibility === "matching",
        sourceCommit: runtime.sourceCommit, apiVersion: runtime.apiVersion,
      };
    }
    return { kind: "botfleet", pid: body.pid, static: Boolean(body.static) };
  }
  return { kind: "foreign" };
}

/**
 * Decide how the packaged app gets its harness. Pure orchestration over the
 * injected `probe` and `spawn` so the policy carries node tests without
 * Electron.
 *
 * @param {{
 *   ports: number[],
 *   owner?: () => import("./harness-ownership.mjs").HarnessOwner | null,
 *   probe: (port: number, owner?: import("./harness-ownership.mjs").HarnessOwner | null) => Promise<Awaited<ReturnType<typeof probeHarness>>>,
 *   spawn: (port: number) => Promise<{ proc: unknown } | { proc: null, reason?: string }>,
 *   attempts?: number,
 *   retrySettleMs?: number,
 *   attachSettleMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<
 *   | { mode: "attached", port: number, pid: number, static: boolean }
 *   | { mode: "spawned", port: number, proc: unknown }
 *   | { mode: "failed", conflictOnly: boolean }
 * >}
 */
export async function resolvePackagedServer({
  ports,
  owner,
  probe,
  spawn,
  attempts = 2,
  retrySettleMs = 2_500,
  attachSettleMs = ATTACH_SETTLE_MS,
  sleep = defaultSleep,
  log = () => {},
}) {
  // true only while every failed port was held by a non-BotFleet program —
  // decides which error-page message renders when nothing works out.
  let everyPortForeignOwned = true;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let currentOwner;
    try { currentOwner = owner?.() ?? null; } catch {
      log("cannot validate data ownership; refusing to spawn another harness");
      return { mode: "failed", conflictOnly: false };
    }
    const candidatePorts = currentOwner ? [currentOwner.port] : ports;
    const freePorts = [];
    let uncertain = Boolean(currentOwner);
    // Inspect every candidate before spawning: the first port can be free
    // while a harness owns the data on a later one.
    for (const port of candidatePorts) {
      let seen = await probe(port, currentOwner);
      if (seen.kind === "botfleet" && owner && !currentOwner) {
        // A legacy process cannot prove which data directory it serves.
        // Re-read on the next pass in case an updated owner is still booting.
        // Never attach and replay credentials to an unproven data root.
        log(`harness on port ${port} has no data ownership proof; update and restart it before attaching`);
        uncertain = true;
        everyPortForeignOwned = false;
        continue;
      }
      if (seen.kind === "botfleet" && attachSettleMs > 0) {
        const firstPid = seen.pid;
        await sleep(attachSettleMs);
        seen = await probe(port, currentOwner);
        if (seen.kind !== "botfleet") {
          log(`harness on port ${port} (pid ${firstPid}) changed during settle: ${seen.kind}`);
        } else if (seen.pid !== firstPid) {
          log(`harness on port ${port} restarted during settle (pid ${firstPid} -> ${seen.pid})`);
        }
      }
      if (seen.kind === "botfleet") {
        log(`attaching to the BotFleet harness already on port ${port} (pid ${seen.pid}, build=${seen.sourceCommit ?? "unknown"}, api=${seen.apiVersion ?? "unknown"}, UI=${seen.static ? "attached" : "bundled"})`);
        return { mode: "attached", port, pid: seen.pid, static: seen.static };
      }
      if (seen.kind === "foreign") {
        log(`port ${port} answered health checks from another program`);
        continue;
      }
      if (seen.kind === "unavailable") {
        uncertain = true;
        everyPortForeignOwned = false;
      } else {
        freePorts.push(port);
      }
    }
    if (currentOwner) everyPortForeignOwned = false;
    for (const port of uncertain ? [] : freePorts) {
      const started = await spawn(port);
      if (started.proc) return { mode: "spawned", port, proc: started.proc };
      // A child that exited or timed out is not evidence of a port conflict —
      // only "another process answered health checks" is.
      if (started.reason !== "foreign-owner") everyPortForeignOwned = false;
    }
    if (attempt < attempts - 1) await sleep(retrySettleMs);
  }
  return { mode: "failed", conflictOnly: everyPortForeignOwned };
}

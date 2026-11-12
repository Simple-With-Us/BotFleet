import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOOMED_FAILURE_THRESHOLD,
  DOOMED_TTL_MS,
  DoomedDispatchRegistry,
} from "./doomed-dispatch.ts";

const T0 = 1_780_000_000_000;

describe("doomed-dispatch breaker", () => {
  it("does not open on a single setup failure", () => {
    const r = new DoomedDispatchRegistry();
    expect(r.recordFailure("bot", "dsh", "spawn ENOENT", T0)).toBeNull();
    expect(r.isOpen("bot", "dsh", T0)).toBe(false);
  });

  it("opens once the threshold is crossed and then refuses the pair", () => {
    const r = new DoomedDispatchRegistry();
    for (let i = 0; i < DOOMED_FAILURE_THRESHOLD; i++) {
      r.recordFailure("bot", "dsh", "spawn ENOENT", T0 + i);
    }
    expect(r.isOpen("bot", "dsh", T0)).toBe(true);
    // …and only that pair. A different bot or a different engine is a
    // different fact and must not inherit someone else's dead CLI.
    expect(r.isOpen("other-bot", "dsh", T0)).toBe(false);
    expect(r.isOpen("bot", "grok", T0)).toBe(false);
  });

  it("keeps a steady failure rate closed instead of leaking a probe every TTL", () => {
    const r = new DoomedDispatchRegistry();
    for (let i = 0; i < DOOMED_FAILURE_THRESHOLD; i++) r.recordFailure("bot", "dsh", undefined, T0);
    // Just before expiry it is still refusing…
    expect(r.isOpen("bot", "dsh", T0 + DOOMED_TTL_MS - 1)).toBe(true);
    // …and a failure that lands at expiry re-stamps it, so the next TTL is
    // closed too rather than alternating open/probe forever.
    r.recordFailure("bot", "dsh", undefined, T0 + DOOMED_TTL_MS);
    expect(r.isOpen("bot", "dsh", T0 + DOOMED_TTL_MS + 1)).toBe(true);
  });

  it("half-opens after the TTL and re-opens on a single further failure", () => {
    const r = new DoomedDispatchRegistry();
    for (let i = 0; i < DOOMED_FAILURE_THRESHOLD; i++) r.recordFailure("bot", "dsh", undefined, T0);
    const after = T0 + DOOMED_TTL_MS + 1;
    // The probe is let through…
    expect(r.isOpen("bot", "dsh", after)).toBe(false);
    // …and because the consecutive count survived, one failure is enough to
    // close it again. That is the self-healing half-open.
    r.recordFailure("bot", "dsh", undefined, after);
    expect(r.isOpen("bot", "dsh", after)).toBe(true);
  });

  it("clears on a successful turn so a fixed engine recovers without a restart", () => {
    const r = new DoomedDispatchRegistry();
    for (let i = 0; i < DOOMED_FAILURE_THRESHOLD; i++) r.recordFailure("bot", "dsh", undefined, T0);
    expect(r.isOpen("bot", "dsh", T0)).toBe(true);
    r.recordSuccess("bot", "dsh");
    expect(r.isOpen("bot", "dsh", T0)).toBe(false);
    // …and the count starts from zero again, so one bad patch after the fix
    // is not instantly treated as a dead engine.
    r.recordFailure("bot", "dsh", undefined, T0);
    expect(r.isOpen("bot", "dsh", T0)).toBe(false);
  });

  it("ignores blank ids rather than keying everything under ':'", () => {
    const r = new DoomedDispatchRegistry();
    expect(r.recordFailure("", "dsh", undefined, T0)).toBeNull();
    expect(r.isOpen("", "dsh", T0)).toBe(false);
    expect(r.isOpen("bot", "", T0)).toBe(false);
  });

  it("round-trips through a versioned envelope without resurrecting a refusal", () => {
    // `load()` has no clock parameter - it uses the real one, like
    // QuotaCooldownRegistry - so a persisted row is written relative to now.
    const T0 = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "doomed-"));
    const path = join(dir, "doomed-dispatches.json");
    const writes: string[] = [];
    const first = new DoomedDispatchRegistry();
    first.enablePersist(path, (_p, json) => writes.push(json));
    for (let i = 0; i < DOOMED_FAILURE_THRESHOLD; i++) first.recordFailure("bot", "dsh", "spawn ENOENT", T0);
    expect(JSON.parse(writes.at(-1)!)).toMatchObject({ version: 1 });

    // A real file, a fresh registry, a clock past the TTL: the row is stale
    // and must not resurrect a refusal for an engine that may be fine now.
    writeFileSync(path, writes.at(-1)!);
    const reloaded = new DoomedDispatchRegistry();
    reloaded.enablePersist(path, () => {});
    expect(reloaded.isOpen("bot", "dsh", T0)).toBe(true);
    expect(reloaded.isOpen("bot", "dsh", T0 + DOOMED_TTL_MS + 1)).toBe(false);
  });

  it("keeps an expired breaker's count across a restart, so the probe still re-opens on one failure", () => {
    // The process died after the breaker had already expired: the row on
    // disk is past its TTL.  Dropping it on load meant the next failure
    // started a fresh count and a dead engine got three more dispatches
    // instead of one.
    const now = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "doomed-"));
    const path = join(dir, "doomed-dispatches.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      doomed: [{
        botId: "bot",
        instanceId: "dsh",
        consecutiveFailures: DOOMED_FAILURE_THRESHOLD,
        openedAt: now - DOOMED_TTL_MS - 1,
        lastFailureAt: now - DOOMED_TTL_MS - 1,
      }],
    }));
    const r = new DoomedDispatchRegistry();
    r.enablePersist(path, () => {});
    // The refusal itself stays expired...
    expect(r.isOpen("bot", "dsh", now)).toBe(false);
    // ...but the count survived the restart, so one more failure re-opens.
    r.recordFailure("bot", "dsh", "spawn ENOENT", now);
    expect(r.isOpen("bot", "dsh", now)).toBe(true);
  });

  it("listing the registry does not delete the half-open state it reports", () => {
    const r = new DoomedDispatchRegistry();
    for (let i = 0; i < DOOMED_FAILURE_THRESHOLD; i++) r.recordFailure("bot", "dsh", undefined, T0);
    // A status view after expiry used to sweep the entry away entirely.
    expect(r.list(T0 + DOOMED_TTL_MS + 1)).toHaveLength(1);
    // The probe still re-opens on a single failure.
    r.recordFailure("bot", "dsh", undefined, T0 + DOOMED_TTL_MS + 2);
    expect(r.isOpen("bot", "dsh", T0 + DOOMED_TTL_MS + 2)).toBe(true);
  });

  it("treats a corrupt file as an empty registry rather than refusing every bot", () => {
    const T0 = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "doomed-"));
    const path = join(dir, "doomed-dispatches.json");
    writeFileSync(path, "{not json");
    const r = new DoomedDispatchRegistry();
    r.enablePersist(path, () => {});
    expect(r.isOpen("bot", "dsh", T0)).toBe(false);
    expect(r.list(T0)).toEqual([]);
  });

  it("keeps a recent row and discards a malformed one on load", () => {
    const T0 = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "doomed-"));
    const path = join(dir, "doomed-dispatches.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        doomed: [
          { botId: "bot", instanceId: "dsh", consecutiveFailures: 9, openedAt: T0 },
          { instanceId: "dsh" },
          null,
        ],
      }),
    );
    const r = new DoomedDispatchRegistry();
    r.enablePersist(path, () => {});
    expect(r.list(T0)).toHaveLength(1);
    expect(r.peek("bot", "dsh")?.consecutiveFailures).toBe(9);
  });

  it("forgets a pair only after a day of silence, so list() stays bounded", () => {
    const T0 = Date.now();
    const DAY_MS = 24 * 60 * 60_000; // mirrors DOOMED_MEMORY_MS
    const r = new DoomedDispatchRegistry();
    // Three pairs, each opened properly.
    for (const id of ["bot-a", "bot-b", "bot-c"]) {
      for (let i = 0; i < DOOMED_FAILURE_THRESHOLD; i++) r.recordFailure(id, "dsh", undefined, T0);
    }
    expect(r.list(T0)).toHaveLength(3);
    // Expired but remembered: the half-open counts are the whole point.
    expect(r.list(T0 + DOOMED_TTL_MS + 1)).toHaveLength(3);
    // A day of silence is what finally forgets them.
    expect(r.list(T0 + DAY_MS + 1)).toHaveLength(0);
  });

  it("keeps a sub-threshold counter past the TTL: consecutive means no success between, not a clock", () => {
    const T0 = Date.now();
    const r = new DoomedDispatchRegistry();
    r.recordFailure("bot", "dsh", undefined, T0);
    expect(r.peek("bot", "dsh")?.consecutiveFailures).toBe(1);
    // A status view used to reset the counter, which let a once-an-hour
    // routine fail forever without ever opening the breaker.
    r.list(T0 + DOOMED_TTL_MS + 1);
    expect(r.peek("bot", "dsh")?.consecutiveFailures).toBe(1);
    r.recordFailure("bot", "dsh", undefined, T0 + DOOMED_TTL_MS + 1);
    r.recordFailure("bot", "dsh", undefined, T0 + DOOMED_TTL_MS + 2);
    expect(r.isOpen("bot", "dsh", T0 + DOOMED_TTL_MS + 2)).toBe(true);
  });
});

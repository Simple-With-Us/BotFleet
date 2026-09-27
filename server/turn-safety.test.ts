import { describe, expect, it, vi } from "vitest";

import {
  ActiveTurnOwners,
  ExactTurnLeases,
  TurnOwnerClaims,
  eligibleAutoFallbackChain,
  inspectThreadOwners,
  interruptThreadOwners,
  mayReleaseStalledTurn,
  scheduleStalledReleaseRecheck,
  stalledReleaseDecision,
  type AutoFallbackCandidate,
  type StalledReleaseDecision,
  type ThreadRuntimeInstance,
} from "./turn-safety.ts";
import { vpsAliasChangeError, VPS_ALIAS_CHANGE_ERROR } from "./cloud-backend.ts";

const candidate = (
  instanceId: string,
  patch: Partial<AutoFallbackCandidate> = {},
): AutoFallbackCandidate => ({
  instanceId,
  models: { default: `${instanceId}-model` },
  snapshot: { state: "available", authenticated: true },
  ...patch,
});

describe("active turn ownership", () => {
  it("measures each dispatch with a monotonic clock, even on a shared room thread", () => {
    let clock = 100;
    const owners = new ActiveTurnOwners(() => clock);
    const selection = (instanceId: string) => ({ instanceId, model: "m" });
    owners.claim("room", { botId: "bot-1", selection: selection("primary"), fallbackPolicy: selection("primary") });
    clock = 350;
    owners.claim("room", { botId: "bot-2", selection: selection("fallback"), fallbackPolicy: selection("fallback") });
    clock = 600;

    expect(owners.settle("room", "primary")?.latencyMs).toBe(500);
    clock = 850;
    expect(owners.settle("room", "fallback")?.latencyMs).toBe(500);
    expect(owners.settle("room", "primary")).toBeUndefined();
  });

  it("leaves duration unavailable if a clock reading cannot form an elapsed interval", () => {
    let clock = 100;
    const owners = new ActiveTurnOwners(() => clock);
    const selection = { instanceId: "primary", model: "m" };
    owners.claim("thread", { botId: "bot", selection, fallbackPolicy: selection });
    clock = NaN;
    expect(owners.settle("thread", "primary")?.latencyMs).toBeUndefined();
  });

  it("records what a live dispatch mounted, and nothing for a replaced one", () => {
    const owners = new ActiveTurnOwners();
    const selection = { instanceId: "primary", model: "m" };
    const claimed = owners.claim("thread-1", {
      botId: "bot-1",
      selection,
      fallbackPolicy: selection,
      computerInputs: { computers: undefined, cloudBackend: "box" },
    });
    owners.recordMounted("thread-1", claimed.dispatchId + 1, ["asciiBox"]);
    expect(owners.forBot("bot-1")?.computerInputs?.mounted).toBeUndefined();
    owners.recordMounted("thread-1", claimed.dispatchId, ["localMac"]);
    expect(owners.forBot("bot-1")?.computerInputs).toEqual({ computers: undefined, cloudBackend: "box", mounted: ["localMac"] });
    owners.settle("thread-1", "primary");
    owners.recordMounted("thread-1", claimed.dispatchId, ["asciiBox"]);
    expect(owners.forBot("bot-1")).toBeUndefined();
  });

  it("fences only the exact dispatch whose computer access was revoked", () => {
    const owners = new ActiveTurnOwners();
    const selection = { instanceId: "primary", model: "m" };
    const claimed = owners.claim("thread-1", { botId: "bot-1", selection, fallbackPolicy: selection });
    expect(owners.isRevoked("thread-1", claimed.dispatchId)).toBe(false);
    // A replaced or unknown dispatch is left alone.
    expect(owners.revoke("thread-1", claimed.dispatchId + 1)).toBe(false);
    expect(owners.revoke("thread-2", claimed.dispatchId)).toBe(false);
    expect(owners.isRevoked("thread-1", claimed.dispatchId)).toBe(false);
    expect(owners.revoke("thread-1", claimed.dispatchId)).toBe(true);
    expect(owners.isRevoked("thread-1", claimed.dispatchId)).toBe(true);
    // The owner is still there to settle; the fence is what its pre-dispatch
    // check reads.
    expect(owners.forEvent("thread-1", "primary")?.revoked).toBe(true);
    owners.settle("thread-1", "primary");
    expect(owners.isRevoked("thread-1", claimed.dispatchId)).toBe(false);
    // A fresh dispatch on the same thread starts unfenced.
    const next = owners.claim("thread-1", { botId: "bot-1", selection, fallbackPolicy: selection });
    expect(owners.isRevoked("thread-1", next.dispatchId)).toBe(false);
    expect(owners.revoke("thread-1", claimed.dispatchId)).toBe(false);
  });

  it("keeps the computer settings a turn was dispatched with, whatever the bot says later", () => {
    const owners = new ActiveTurnOwners();
    const selection = { instanceId: "primary", model: "m" };
    const computers: ("cloud" | "vm" | "local")[] = ["cloud"];
    owners.claim("thread-1", {
      botId: "bot-1",
      selection,
      fallbackPolicy: selection,
      computerInputs: { computers: [...computers], cloudBackend: "box" },
    });
    // The bot is switched to Local VM mid-turn; the live Box mount is not.
    computers.splice(0, 1, "vm");
    expect(owners.forBot("bot-1")?.computerInputs).toEqual({ computers: ["cloud"], cloudBackend: "box" });
  });

  it("attributes a fallback completion to the dispatched override and preserves a newer owner", () => {
    const owners = new ActiveTurnOwners();
    const policy = {
      instanceId: "primary",
      model: "primary-model",
      fallbacks: [{ instanceId: "fallback", model: "fallback-model" }],
    };
    owners.claim("thread-1", {
      botId: "bot-1",
      selection: policy,
      fallbackPolicy: policy,
    });
    owners.claim("thread-1", {
      botId: "bot-1",
      selection: policy.fallbacks[0],
      fallbackPolicy: policy,
    });

    expect(owners.forEvent("thread-1", "fallback")?.selection).toEqual(policy.fallbacks[0]);
    expect(owners.settle("thread-1", "primary")?.selection.instanceId).toBe("primary");
    expect(owners.current("thread-1")?.selection.instanceId).toBe("fallback");
    expect(owners.threadForBot("bot-1")).toBe("thread-1");
    expect(owners.forBot("bot-1")?.selection.instanceId).toBe("fallback");
  });

  it("rejects two live claims for the same thread and provider instance", () => {
    const owners = new ActiveTurnOwners();
    const selection = { instanceId: "primary", model: "primary-model" };
    owners.claim("thread-1", { botId: "bot-1", selection, fallbackPolicy: selection });

    expect(() => owners.claim("thread-1", {
      botId: "bot-1",
      selection: { ...selection, model: "newer-model" },
      fallbackPolicy: selection,
    })).toThrow(/already has a live turn/);
    expect(owners.current("thread-1")?.selection.model).toBe("primary-model");
  });

  it("gives a later same-thread dispatch a distinct generation", () => {
    const owners = new ActiveTurnOwners();
    const selection = { instanceId: "primary", model: "primary-model" };
    const first = owners.claim("thread-1", { botId: "bot-1", selection, fallbackPolicy: selection });
    owners.settle("thread-1", selection.instanceId);
    const next = owners.claim("thread-1", { botId: "bot-1", selection, fallbackPolicy: selection });

    expect(next.dispatchId).not.toBe(first.dispatchId);
    expect(owners.isLatest("thread-1", first.dispatchId)).toBe(false);
    expect(owners.isLatest("thread-1", next.dispatchId)).toBe(true);
    owners.settle("thread-1", selection.instanceId);
    expect(owners.isLatest("thread-1", first.dispatchId)).toBe(false);
    expect(owners.isLatest("thread-1", next.dispatchId)).toBe(true);
    expect(mayReleaseStalledTurn(next.dispatchId !== first.dispatchId, {
      owners: [],
      inspectionFailed: false,
    })).toBe(false);
  });
});

describe("exact turn leases", () => {
  it("does not let an older finalizer release a successor on the same bot and thread", () => {
    const leases = new ExactTurnLeases();
    const oldLease = leases.claim("bot-1", "thread-1", 1);
    const releaseOldFinalScreenshot = () => leases.release(oldLease!);
    const successor = leases.claim("bot-1", "thread-1", 2);

    expect(releaseOldFinalScreenshot()).toBe(false);
    expect(leases.forBot("bot-1")).toBe(successor);
    expect(vpsAliasChangeError("old-vps", "new-vps", leases.size > 0)).toBe(VPS_ALIAS_CHANGE_ERROR);
    expect(leases.release(successor!)).toBe(true);
    expect(leases.size).toBe(0);
  });

  it("prevents two different bots from holding the same occupancy target key", () => {
    const leases = new ExactTurnLeases();
    const first = leases.claim("bot-a", "thread-a", 10, "shared");
    expect(first).not.toBeNull();
    expect(leases.hasTarget("shared")).toBe(true);

    // A different bot on the same target is refused.
    const second = leases.claim("bot-b", "thread-b", 11, "shared");
    expect(second).toBeNull();
    expect(leases.forBot("bot-b")).toBeUndefined();

    // Same bot + thread (successor) replaces the lease.
    const successor = leases.claim("bot-a", "thread-a", 12, "shared");
    expect(successor).not.toBeNull();
    expect(successor!.dispatchId).toBe(12);
    expect(leases.hasTarget("shared")).toBe(true);

    // Release frees both maps.
    expect(leases.release(successor!)).toBe(true);
    expect(leases.hasTarget("shared")).toBe(false);
    expect(leases.hasBot("bot-a")).toBe(false);
    expect(leases.size).toBe(0);
  });

  it("lets the same bot reclaim a stale target lease from a different thread", () => {
    // Missed release used to leave byTarget occupied; same-bot reclaim must
    // overwrite so a bot cannot permanently self-block after a crashed unwind.
    const leases = new ExactTurnLeases();
    const stale = leases.claim("bot-a", "thread-old", 10, "shared");
    expect(stale).not.toBeNull();
    const next = leases.claim("bot-a", "thread-new", 11, "shared");
    expect(next).not.toBeNull();
    expect(leases.release(stale!)).toBe(false);
    expect(leases.forBot("bot-a")).toBe(next);
    expect(leases.hasTarget("shared")).toBe(true);
  });

  it("allows two different bots on distinct per-bot target keys", () => {
    const leases = new ExactTurnLeases();
    const a = leases.claim("bot-a", "thread-a", 20, "bot:aaa");
    const b = leases.claim("bot-b", "thread-b", 21, "bot:bbb");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(leases.size).toBe(2);
    expect(leases.hasTarget("bot:aaa")).toBe(true);
    expect(leases.hasTarget("bot:bbb")).toBe(true);
  });

  it("clearBot removes the target entry too", () => {
    const leases = new ExactTurnLeases();
    leases.claim("bot-x", "thread-x", 30, "shared");
    expect(leases.hasTarget("shared")).toBe(true);
    leases.clearBot("bot-x");
    expect(leases.hasTarget("shared")).toBe(false);
    expect(leases.size).toBe(0);
  });
});

describe("automatic fallback eligibility", () => {
  it("skips unavailable, signed-out, capped, and cooling engines without disturbing stable priority", () => {
    const cooling = new Set(["cooling:cooling-model"]);
    const chain = eligibleAutoFallbackChain(
      [
        candidate("current"),
        candidate("unavailable", { snapshot: { state: "unavailable" } }),
        candidate("signed-out", { snapshot: { state: "available", authenticated: false } }),
        candidate("capped", { snapshot: { state: "available", quota: { capped: true } } }),
        candidate("model-capped", {
          snapshot: {
            state: "available",
            quota: { capped: false, models: { "model-capped-model": { capped: true } } },
          },
        }),
        candidate("cooling"),
        candidate("second"),
        candidate("first"),
      ],
      {
        botId: "bot-1",
        currentInstanceId: "current",
        isCooling: (_botId, instanceId, model) => cooling.has(`${instanceId}:${model}`),
        priority: ["unavailable", "signed-out", "capped", "model-capped", "cooling", "first", "second"],
      },
    );

    expect(chain).toEqual([{ instanceId: "first", model: "first-model" }]);
  });

  it("keeps registry order when viable candidates have equal priority", () => {
    expect(eligibleAutoFallbackChain(
      [candidate("custom-b"), candidate("custom-a")],
      {
        botId: "bot-1",
        currentInstanceId: "current",
        isCooling: () => false,
        priority: ["claude", "codex"],
      },
    )).toEqual([{ instanceId: "custom-b", model: "custom-b-model" }]);
  });

  it("treats a MiniMax candidate as eligible when its chat model is uncapped, regardless of an unrelated video-pool exhaustion", () => {
    // server/harness/registry.ts maps MiniMax's "general" (chat) pool onto
    // every catalog model id and keeps other pools ("video", …) out of
    // `models` entirely — this pins that THIS function (keying strictly by
    // `candidate.models.default`, i.e. a catalog model id) reads that
    // shape correctly: a video pool being exhausted must never surface
    // here at all, since it was never placed under any model id.
    const chain = eligibleAutoFallbackChain(
      [
        candidate("current"),
        candidate("minimax", {
          models: { default: "MiniMax-M3" },
          snapshot: {
            state: "available",
            quota: { capped: false, models: { "MiniMax-M3": { capped: false } } },
          },
        }),
      ],
      {
        botId: "bot-1",
        currentInstanceId: "current",
        isCooling: () => false,
        priority: ["minimax"],
      },
    );
    expect(chain).toEqual([{ instanceId: "minimax", model: "MiniMax-M3" }]);
  });

  it("excludes a MiniMax candidate whose chat model IS capped, keyed by the catalog model id", () => {
    const chain = eligibleAutoFallbackChain(
      [
        candidate("current"),
        candidate("minimax", {
          models: { default: "MiniMax-M3" },
          snapshot: {
            state: "available",
            quota: { capped: false, models: { "MiniMax-M3": { capped: true } } },
          },
        }),
      ],
      {
        botId: "bot-1",
        currentInstanceId: "current",
        isCooling: () => false,
        priority: ["minimax"],
      },
    );
    expect(chain).toEqual([]);
  });
});

describe("runtime-owner interruption", () => {
  const runtime = (
    instanceId: string,
    hasSession: () => boolean,
    interruptTurn: () => Promise<void> = async () => undefined,
  ): ThreadRuntimeInstance => ({
    instanceId,
    adapter: { hasSession, interruptTurn: vi.fn(interruptTurn) },
  });

  it("reports an inspection failure so a watchdog cannot release uncertain ownership", () => {
    const onError = vi.fn();
    const inspection = inspectThreadOwners([
      runtime("broken", () => { throw new Error("probe failed"); }),
      runtime("owner", () => true),
    ], "thread-1", onError);

    expect(inspection.owners.map((owner) => owner.instanceId)).toEqual(["owner"]);
    expect(inspection.inspectionFailed).toBe(true);
    expect(onError).toHaveBeenCalledWith("broken", expect.any(Error));
  });

  it("releases only after every owner exited and no newer dispatch is watched", () => {
    const noOwners = { owners: [], inspectionFailed: false };
    expect(mayReleaseStalledTurn(false, noOwners)).toBe(true);
    expect(stalledReleaseDecision(false, noOwners)).toBe("release");
    expect(mayReleaseStalledTurn(true, noOwners)).toBe(false);
    expect(stalledReleaseDecision(true, noOwners)).toBe("superseded");
    const liveOwner = { owners: [runtime("live", () => true)], inspectionFailed: false };
    expect(mayReleaseStalledTurn(false, liveOwner)).toBe(false);
    expect(stalledReleaseDecision(false, liveOwner)).toBe("retry");
    const uncertain = { owners: [], inspectionFailed: true };
    expect(mayReleaseStalledTurn(false, uncertain)).toBe(false);
    expect(stalledReleaseDecision(false, uncertain)).toBe("retry");
    expect(stalledReleaseDecision(false, noOwners, true)).toBe("retry");
  });

  it("rechecks retained ownership with bounded backoff until release", () => {
    const decisions: StalledReleaseDecision[] = ["retry", "retry", "retry", "retry", "retry", "release"];
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    scheduleStalledReleaseRecheck(
      () => decisions.shift() ?? "release",
      (callback, delayMs) => scheduled.push({ callback, delayMs }),
    );

    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([6_000]);
    scheduled.shift()!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([12_000]);
    scheduled.shift()!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([24_000]);
    scheduled.shift()!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([48_000]);
    scheduled.shift()!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([60_000]);
    scheduled.shift()!.callback();
    expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([60_000]);
    scheduled.shift()!.callback();
    expect(scheduled).toEqual([]);
  });

  it("stops rechecking when a newer dispatch supersedes the stalled turn", () => {
    const scheduled: Array<() => void> = [];
    scheduleStalledReleaseRecheck(
      () => "superseded",
      (callback) => scheduled.push(callback),
    );
    scheduled.shift()!();
    expect(scheduled).toEqual([]);
  });

  it("distinguishes a refused stop from an owner that actually accepted interruption", async () => {
    const refused = runtime("refused", () => true, async () => { throw new Error("still live"); });
    const stopped = runtime("stopped", () => true);
    const onError = vi.fn();

    await expect(interruptThreadOwners([refused], "thread-1", undefined, onError)).resolves.toEqual({
      stopped: false,
      refused: true,
      ownerCount: 1,
      inspectionFailed: false,
    });
    await expect(interruptThreadOwners([refused, stopped], "thread-1")).resolves.toEqual({
      stopped: true,
      refused: false,
      ownerCount: 2,
      inspectionFailed: false,
    });
    expect(onError).toHaveBeenCalledWith("refused", expect.any(Error));
  });
});

describe("TurnOwnerClaims", () => {
  // A room thread is shared by every member, and nothing serializes them at
  // the thread level, so two members can hold a computer on one thread at
  // once.  Keyed by thread alone, the second claim evicted the first: one
  // resource stranded until restart, the other handed back mid-turn.
  it("keeps two members of one room thread apart", () => {
    const claims = new TurnOwnerClaims<string>();
    claims.set("room-1", "bot-a", "lease-a");
    claims.set("room-1", "bot-b", "lease-b");

    expect(claims.size).toBe(2);
    expect(claims.get("room-1", "bot-a")).toBe("lease-a");
    expect(claims.get("room-1", "bot-b")).toBe("lease-b");

    // A's turn ends.  B is still running, so B keeps what it holds.
    expect(claims.release("room-1", "bot-a")).toBe("lease-a");
    expect(claims.get("room-1", "bot-a")).toBeUndefined();
    expect(claims.get("room-1", "bot-b")).toBe("lease-b");
    expect(claims.size).toBe(1);
  });

  it("declines a thread-only release it cannot attribute, and takes it when it can", () => {
    // `turn.completed` is thread-keyed and names no speaker.  With two
    // members in flight, releasing either would be a guess — and guessing
    // wrong hands back a container another bot is still working inside.
    const claims = new TurnOwnerClaims<string>();
    claims.set("room-1", "bot-a", "lease-a");
    claims.set("room-1", "bot-b", "lease-b");

    expect(claims.releaseSoleOwner("room-1")).toBeUndefined();
    expect(claims.size).toBe(2);

    // Once only one member is left, the same caller can attribute it.
    claims.release("room-1", "bot-b");
    expect(claims.releaseSoleOwner("room-1")).toBe("lease-a");
    expect(claims.size).toBe(0);
    expect(claims.releaseSoleOwner("room-1")).toBeUndefined();
  });

  it("the room stall/timeout path uses the exact key, so a second member in flight does not strand the lease", () => {
    // Board aac035dd tracked this exact shape: a room turn that stalls (or
    // times out) returns before its own unwind, no turn.completed comes, and
    // the only other path that releases the room computer lease is the
    // thread-keyed `turn.completed` subscriber — and that subscriber's
    // `releaseSoleOwner` declines while a second member is in flight on the
    // same thread.  The dispatcher's own settlement has to release by exact
    // key BEFORE the stalled/timed-out early return, or the lease strands
    // until the next sole-owner completion heals it.
    const claims = new TurnOwnerClaims<string>();
    claims.set("room-1", "bot-a", "lease-a");
    claims.set("room-1", "bot-b", "lease-b");

    // The thread-only path declines — both members are in flight.
    expect(claims.releaseSoleOwner("room-1")).toBeUndefined();
    expect(claims.size).toBe(2);

    // The dispatcher's stall/timeout settlement uses the exact key: the
    // stalled turn knows its own bot id, so it can attribute the release.
    expect(claims.release("room-1", "bot-a")).toBe("lease-a");
    expect(claims.get("room-1", "bot-a")).toBeUndefined();
    // bot-b is still working — its lease is preserved exactly because the
    // release named the speaker, not the thread.
    expect(claims.get("room-1", "bot-b")).toBe("lease-b");
    expect(claims.size).toBe(1);
  });

  it("keeps threads separate and answers the two lookups the dispatchers need", () => {
    const claims = new TurnOwnerClaims<string>();
    claims.set("room-1", "bot-a", "lease-a");
    claims.set("chat-9", "bot-a", "lease-9");

    expect(claims.ownersOf("room-1")).toEqual(["bot-a"]);
    expect(claims.anyOnThread("chat-9")).toBe("lease-9");
    expect(claims.anyOnThread("nobody")).toBeUndefined();
    // `clearBot` on a provider reload has to find the claim by bot alone.
    expect(claims.findByBot("bot-a")).toMatchObject({ threadId: "room-1", botId: "bot-a" });
    expect(claims.findByBot("bot-z")).toBeUndefined();

    // Releasing one thread's claim leaves the same bot's other one alone.
    claims.release("room-1", "bot-a");
    expect(claims.get("chat-9", "bot-a")).toBe("lease-9");
  });
});

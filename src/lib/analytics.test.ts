// The opt-out has one job that matters: an install that turned analytics off
// must not talk to PostHog at all. optAction pins the decision, and the
// storage round-trip pins that the choice survives a restart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PostHog } from "posthog-js";

import { analyticsEnabled, optAction, setAnalyticsEnabled } from "./analytics";

// The suite runs on the node environment, which has no localStorage.
const store = new Map<string, string>();
const baseStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
vi.stubGlobal("localStorage", baseStorage);

beforeEach(() => store.clear());
// Tests that swap in a throwing storage get the base one back even when an
// assertion fails mid-test — an inline restore at the end would be skipped.
afterEach(() => vi.stubGlobal("localStorage", baseStorage));

describe("optAction", () => {
  it("initialises on the first opt-in of a session that started off", () => {
    expect(optAction(true, false)).toBe("init");
  });

  it("opts a running client back in rather than initialising twice", () => {
    expect(optAction(true, true)).toBe("opt-in");
  });

  it("stops a running client without waiting for a restart", () => {
    expect(optAction(false, true)).toBe("opt-out");
  });

  it("does nothing when there is no client to stop", () => {
    // The important half: opting out before init must not reach PostHog to
    // tell it so — that request would itself be the leak.
    expect(optAction(false, false)).toBe("none");
  });
});

describe("the stored choice", () => {
  it("is on for a fresh install", () => {
    expect(analyticsEnabled()).toBe(true);
  });

  it("survives a restart once opted out", () => {
    setAnalyticsEnabled(false);
    expect(analyticsEnabled()).toBe(false); // same read a later launch performs
  });

  it("can be turned back on", () => {
    setAnalyticsEnabled(false);
    setAnalyticsEnabled(true);
    expect(analyticsEnabled()).toBe(true);
  });

  it("holds an opt-out for the session even when the write is rejected", async () => {
    // The failure this guards: the setter swallows the write error, the next
    // read finds nothing and answers "enabled", and a later initAnalytics()
    // starts the client the user just switched off.
    vi.resetModules();
    const fresh = await import("./analytics");
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });

    fresh.setAnalyticsEnabled(false);
    expect(fresh.analyticsEnabled()).toBe(false);
    fresh.initAnalytics();
    expect(store.get("omb-installed")).toBeUndefined();
  });

  it("treats unusable storage as a fresh install rather than failing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(analyticsEnabled()).toBe(true);
    expect(() => setAnalyticsEnabled(false)).not.toThrow();
  });
});

describe("initAnalytics while opted out", () => {
  it("returns before touching the client or the install marker", async () => {
    // A fresh module, so the module-scoped `ready` flag starts false: with a
    // used module this test passes on `ready` alone and proves nothing about
    // the opt-out. resetModules is not module mocking — nothing is replaced,
    // the real module is simply loaded again.
    vi.resetModules();
    store.set("omb-analytics-opt-out", "1"); // as a previous session left it
    const fresh = await import("./analytics");

    expect(fresh.analyticsEnabled()).toBe(false);
    fresh.initAnalytics();

    // No client is stubbed on purpose: if init() got past the guard it would
    // reach the real posthog-js and set this marker. Its absence is the
    // proof — and it also means opting back in later still counts the install.
    expect(store.get("omb-installed")).toBeUndefined();
  });
});

// UI3: posthog-js is a dynamic import now, so a call made while it is still
// loading has to queue rather than silently fire or silently drop. Each test
// gets its own fresh module (vi.resetModules(), same as the write-rejection
// test above) so a stand-in loader never risks touching the real package.
describe("PostHog capture gate and queue", () => {
  // Kept as separate typed vi.fn() references, asserted on directly — a fake
  // cast through `as unknown as PostHog` would re-type these members as the
  // real SDK's plain function signatures on the way out, losing the
  // Mock-only matchers (toHaveBeenCalled, toHaveBeenCalledWith).
  let fakeInit: ReturnType<typeof vi.fn>;
  let fakeCapture: ReturnType<typeof vi.fn>;
  let fakeIdentify: ReturnType<typeof vi.fn>;
  let fakeClient: PostHog;
  let resolveLoad: ((client: PostHog) => void) | undefined;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    resolveLoad = undefined;
    fakeInit = vi.fn();
    fakeCapture = vi.fn();
    fakeIdentify = vi.fn();
    fakeClient = {
      init: fakeInit,
      has_opted_out_capturing: () => false,
      opt_in_capturing: vi.fn(),
      opt_out_capturing: vi.fn(),
      capture: fakeCapture,
      identify: fakeIdentify,
    } as unknown as PostHog;
  });

  it("queues track() while the SDK is loading and flushes it once init() resolves", async () => {
    vi.resetModules();
    const fresh = await import("./analytics");
    fresh.setPostHogLoaderForTests(() => new Promise((resolve) => { resolveLoad = resolve; }));

    fresh.initAnalytics();
    fresh.track("clicked_thing", { x: 1 });
    expect(fakeCapture).not.toHaveBeenCalled(); // in flight, not sent and not dropped

    resolveLoad?.(fakeClient);
    await settle();

    expect(fakeInit).toHaveBeenCalledTimes(1);
    expect(fakeCapture).toHaveBeenCalledWith("clicked_thing", { x: 1 });
  });

  it("queues identifyEmail() the same way", async () => {
    vi.resetModules();
    const fresh = await import("./analytics");
    fresh.setPostHogLoaderForTests(() => new Promise((resolve) => { resolveLoad = resolve; }));

    fresh.initAnalytics();
    fresh.identifyEmail("person@example.com");
    expect(fakeIdentify).not.toHaveBeenCalled();

    resolveLoad?.(fakeClient);
    await settle();

    expect(fakeIdentify).toHaveBeenCalledWith("person@example.com", { email: "person@example.com" });
    expect(fakeCapture).toHaveBeenCalledWith("email_submitted");
  });

  it("never calls init() and drops the queue when opted out while the SDK is still loading", async () => {
    vi.resetModules();
    const fresh = await import("./analytics");
    fresh.setPostHogLoaderForTests(() => new Promise((resolve) => { resolveLoad = resolve; }));

    fresh.initAnalytics();
    fresh.track("should_be_dropped");
    fresh.setAnalyticsEnabled(false); // opted out before the chunk finished loading

    resolveLoad?.(fakeClient);
    await settle();

    // init() must never reach the real SDK once the install said no, and the
    // call queued before the opt-out must not survive to fire later either.
    expect(fakeInit).not.toHaveBeenCalled();
    expect(fakeCapture).not.toHaveBeenCalled();
  });

  it("drops track() outright when nothing has ever called initAnalytics()", async () => {
    vi.resetModules();
    const fresh = await import("./analytics");
    // Neither ready nor loading — the steady-state "opted in but no
    // component has mounted yet" case. Must not throw, and there is nothing
    // to flush later since no load was ever started.
    expect(() => fresh.track("too_early")).not.toThrow();
  });
});

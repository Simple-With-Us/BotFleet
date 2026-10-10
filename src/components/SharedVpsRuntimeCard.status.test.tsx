// What a person reads on the Shared VPS card, rendered rather than inferred
// from the source text.  The source-text checks in SharedVpsRuntimeCard.test.ts
// passed while the subtitle printed a literal "\u00a0": a quoted JSX attribute
// is not a JavaScript string, and a substring match cannot see that.

import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const happy = require("happy-dom");
  const win = new happy.Window({ url: "http://127.0.0.1:5199/" });
  const install: Array<[string, unknown]> = [
    ["window", win],
    ["document", win.document],
    ["HTMLElement", win.HTMLElement],
    ["Element", win.Element],
    ["Node", win.Node],
    ["Event", win.Event],
    ["MouseEvent", win.MouseEvent],
    ["MutationObserver", win.MutationObserver],
    ["DOMException", win.DOMException],
    ["getComputedStyle", win.getComputedStyle.bind(win)],
    ["requestAnimationFrame", win.requestAnimationFrame.bind(win)],
    ["cancelAnimationFrame", win.cancelAnimationFrame.bind(win)],
    ["IS_REACT_ACT_ENVIRONMENT", true],
  ];
  for (const [key, value] of install) Reflect.set(globalThis, key, value);
});

import { SharedVpsRuntimeCard } from "./SharedVpsRuntimeCard";
import { initialState, StoreContext, type ConfigStatus } from "@/state/store";

// The real store context with a hand-built config, the way
// RuntimeCardsVisualFixture mounts these cards: a shared-mode workspace with a
// configured VPS and the provider switched on.
const config: ConfigStatus = {
  host: { platform: "darwin" },
  composio: { configured: false },
  box: { configured: false },
  rooms: { turnTimeoutMinutes: 60 },
  vps: { configured: true, sshAlias: "vps" },
  botDefaults: {
    computers: ["vm" as const],
    cloudBackend: "box",
    allowedComputers: ["vm" as const],
    computerProviders: { asciiBox: false, selfHostedVps: true, localVm: true, localMac: false },
    vpsMode: "shared",
  },
  localVm: { mode: "shared", maxInstances: 1, shareCliCredentials: false, allowHostTerminal: false },
};
const storeValue = {
  state: { ...initialState, config },
  dispatch: () => {},
  flushBotPatches: async () => {},
  refreshInstances: async () => {},
};

const NBSP = "\u00a0";

const realFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
  globalThis.fetch = realFetch;
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function readCard(payload: Record<string, unknown>): Promise<string> {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(StoreContext.Provider, { value: storeValue }, createElement(SharedVpsRuntimeCard)));
  });
  await flush();
  await flush();
  return host.textContent ?? "";
}

describe("SharedVpsRuntimeCard subtitle", () => {
  it("renders a real non-breaking sentence gap, never the escape's six characters", async () => {
    const text = await readCard({ container: "running", ready: true, problem: null });
    expect(text).toContain(`separate desktop for each bot.${NBSP} Bots share cookies`);
    expect(text).not.toContain("\\u00a0");
    expect(text).not.toMatch(/\\u[0-9a-f]{4}/i);
  });
});

describe("SharedVpsRuntimeCard with one timed-out desktop check", () => {
  it("says it could not check just now, beside a container that is running", async () => {
    const text = await readCard({
      backend: "vps",
      configured: true,
      sshAlias: "vps",
      daemonUp: true,
      image: true,
      managed: true,
      container: "running",
      ready: false,
      problem: "Couldn't reach the VPS desktop just now; retrying",
    });
    expect(text).toContain("Running");
    expect(text).toContain("The VPS container is up and running.");
    expect(text).toContain("Couldn't reach the VPS desktop just now; retrying");
    expect(text).not.toMatch(/failed to start/i);
  });
});

describe("SharedVpsRuntimeCard on an outdated image", () => {
  const stale = {
    backend: "vps",
    configured: true,
    sshAlias: "vps",
    daemonUp: true,
    managed: true,
    container: "running",
    ready: false,
    imageOutdated: true,
  };

  it("says the container is outdated and offers Prepare Image", async () => {
    const text = await readCard({
      ...stale,
      image: false,
      imageBuild: { phase: "idle", startedAt: null, elapsedMs: null, error: null },
      problem: "Prepare the pinned BotFleet CUA image on the VPS (Driver 0.20.0)",
    });
    expect(text).toContain("Running (outdated image)");
    expect(text).not.toContain("The VPS container is up and running.");
    expect(text).toContain("so bots can't use it until it switches to the new one");
    expect(text).toContain("Prepare Image");
    expect(text).not.toContain("Switch to New Image");
  });

  it("shows build progress with the elapsed time", async () => {
    const text = await readCard({
      ...stale,
      image: false,
      imageBuild: { phase: "building", startedAt: 1, elapsedMs: 754_000, error: null },
      problem: "Prepare the pinned BotFleet CUA image on the VPS (Driver 0.20.0)",
    });
    expect(text).toContain("Building the new image on the VPS: 12m 34s so far.");
    expect(text).not.toContain("Prepare Image");
  });

  it("offers Switch to New Image once the image is ready", async () => {
    const text = await readCard({
      ...stale,
      image: true,
      imageBuild: { phase: "ready", startedAt: null, elapsedMs: null, error: null },
      problem: "The VPS container uses an incompatible or untrusted BotFleet image",
    });
    expect(text).toContain("Switch to New Image");
    expect(text).toContain("resets its filesystem");
    expect(text).not.toContain("incompatible or untrusted");
  });
});

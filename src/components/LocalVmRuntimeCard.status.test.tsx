// What the Local VM card shows for the status payloads the harness really
// sends.  Static markup cannot run the card's own status poll, so this mounts
// it in a happy-dom document (the suite stays on the node environment because
// the store graph imports node:sqlite) with `/api/local-computer` answered by a
// fetch stub.  The payloads are the live harness's, not hand-tidied ones.

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

import { LocalVmRuntimeCard } from "./LocalVmRuntimeCard";
import { initialState, StoreContext, type ConfigStatus } from "@/state/store";

// The real store context with a hand-built config, the way
// RuntimeCardsVisualFixture mounts these cards: shared mode, Local VM on.
const config: ConfigStatus = {
  host: { platform: "darwin" },
  composio: { configured: false },
  box: { configured: false },
  rooms: { turnTimeoutMinutes: 60 },
  vps: { configured: false, sshAlias: "" },
  botDefaults: {
    computers: ["vm" as const],
    cloudBackend: "box",
    allowedComputers: ["vm" as const],
    computerProviders: { asciiBox: false, selfHostedVps: true, localVm: true, localMac: false },
  },
  localVm: { mode: "shared", maxInstances: 1, shareCliCredentials: false, allowHostTerminal: false },
};
const storeValue = {
  state: { ...initialState, config },
  dispatch: () => {},
  flushBotPatches: async () => {},
  refreshInstances: async () => {},
};
const mountCard = () => createElement(StoreContext.Provider, { value: storeValue }, createElement(LocalVmRuntimeCard));

/** The status the live harness answered with on 2026-10-08, with OrbStack up:
 * the daemon answers, the BotFleet desktop image has never been built, and no
 * container exists yet.  `runtime` is "docker" (OrbStack's CLI); the harness's
 * answer also named it. */
const DAEMON_UP_NO_IMAGE = {
  platform: "darwin",
  runtime: "docker",
  available: ["docker"],
  daemonUp: true,
  image: false,
  imageMatches: false,
  managed: false,
  container: "missing",
  network: "unknown",
  security: "unknown",
  persistence: "unknown",
  desktopReady: false,
  ready: false,
  problem: "Prepare the CUA desktop image with Driver 0.20.0",
};

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
  vi.useRealTimers();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Mount the card against `payload` and return what a person can read. */
async function readCard(payload: Record<string, unknown>) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(mountCard());
  });
  await flush();
  await flush();
  return {
    text: host.textContent ?? "",
    buttons: [...host.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim()),
    pill: host.querySelector("span.rounded-full")?.textContent?.trim() ?? "",
  };
}

describe("LocalVmRuntimeCard with the daemon up and no image yet", () => {
  it("renders without throwing and offers the real next step", async () => {
    const card = await readCard(DAEMON_UP_NO_IMAGE);
    expect(card.buttons).toContain("Prepare Linux Desktop");
    expect(card.text).not.toMatch(/Something Went Wrong/i);
  });

  it("never says to start the runtime, because it is already running", async () => {
    const card = await readCard(DAEMON_UP_NO_IMAGE);
    expect(card.text).not.toMatch(/start docker first/i);
    expect(card.text).not.toMatch(/Open and start/i);
    expect(card.pill).not.toMatch(/^Start /);
  });

  it("names both steps in order: prepare the desktop, then create the VM", async () => {
    const card = await readCard(DAEMON_UP_NO_IMAGE);
    expect(card.pill).toBe("Next: prepare the Linux desktop, then create the VM");
    expect(card.text).toContain("Prepare the Linux desktop above first");
    expect(card.text).toContain("Then create the VM here");
    // Creating the VM is not offered until the image exists.
    expect(card.buttons).not.toContain("Create Local VM");
  });

  it("ignores a contradictory server problem that says to start a runtime the daemon is already running", async () => {
    const card = await readCard({ ...DAEMON_UP_NO_IMAGE, problem: "Start docker first" });
    expect(card.pill).toBe("Next: prepare the Linux desktop, then create the VM");
    expect(card.text).not.toMatch(/start docker first/i);
  });
});

describe("LocalVmRuntimeCard when the status check itself fails", () => {
  it("says the status is unavailable and shows the real reason, never a generic headline", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Load failed");
    }) as typeof fetch;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(mountCard());
    });
    await flush();
    await flush();
    const text = host.textContent ?? "";
    expect(text).toContain("Status unavailable");
    expect(text).toContain("Load failed");
    expect(text).not.toMatch(/Something Went Wrong|start docker first/i);
  });
});

describe("LocalVmRuntimeCard header for the other setup states", () => {
  it("says to start the runtime only while its daemon is down", async () => {
    const card = await readCard({
      ...DAEMON_UP_NO_IMAGE,
      daemonUp: false,
      problem: "Start docker first",
    });
    expect(card.pill).toBe("Start docker first");
    expect(card.text).toContain("Open and start docker");
  });

  it("points at creating the VM once the image exists", async () => {
    const card = await readCard({
      ...DAEMON_UP_NO_IMAGE,
      image: true,
      problem: "Create the Local VM",
    });
    expect(card.pill).toBe("Create the Local VM");
    expect(card.buttons).toContain("Create Local VM");
  });

  it("keeps the server's wording for a VM problem", async () => {
    const card = await readCard({
      ...DAEMON_UP_NO_IMAGE,
      image: true,
      container: "running",
      imageMatches: true,
      managed: true,
      network: "loopback",
      security: "hardened",
      persistence: "durable",
      problem: "Couldn't reach the Local VM desktop just now; retrying",
    });
    expect(card.pill).toBe("Couldn't reach the Local VM desktop just now; retrying");
  });
});

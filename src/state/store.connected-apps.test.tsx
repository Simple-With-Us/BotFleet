// @vitest-environment happy-dom
// The connected-apps inventory is read again when a connection changes.  A
// change that arrives while a read is still running is owed a follow-up
// read, because the answer in flight may predate the change.  That follow-up
// belongs to the effect that is still mounted:  once the store is gone its
// answer would be thrown away, so the request would only spend the
// endpoint's budget.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONNECTED_APPS_CHANGED, StoreProvider } from "./store";

describe("the connected-apps read outlives the store", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let inventoryReads = 0;
  let answer: (() => void) | null = null;

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    inventoryReads = 0;
    answer = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/connectors/connected")) {
          inventoryReads += 1;
          if (inventoryReads === 1) {
            await new Promise<void>((resolve) => {
              answer = resolve;
            });
          }
          return new Response(JSON.stringify({ configured: true, services: {}, authoritative: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    // The store opens an event stream on mount, and happy-dom has no
    // EventSource.  The stream is not what this test is about.
    vi.stubGlobal(
      "EventSource",
      class {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        close() {}
        addEventListener() {}
        removeEventListener() {}
      },
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  it("does not read the inventory again after the store is gone", async () => {
    await act(async () => {
      root!.render(createElement(StoreProvider, null, null));
    });
    // The first read is in flight.
    expect(inventoryReads).toBe(1);

    // A connection changes while that read is still running, so a follow-up
    // read is owed.
    act(() => {
      window.dispatchEvent(new Event(CONNECTED_APPS_CHANGED));
    });

    // The store goes away before the read answers.
    act(() => {
      root!.unmount();
      root = null;
    });

    // The read answers afterwards.
    await act(async () => {
      answer?.();
    });

    // The answer belongs to a store that is gone, so it is not read again.
    expect(inventoryReads).toBe(1);
  });
});

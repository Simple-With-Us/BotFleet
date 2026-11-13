// @vitest-environment happy-dom
// The overview's dismissal rule, rendered: a pick closes it, a store update
// that is not a pick does not.  This is the guard against widening the
// dependencies of the effect again, which once closed the overview on every
// streamed bot update.
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDismissOnSelection } from "./use-dismiss-on-selection";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function Probe(props: { nonce: number; dismiss: () => void; bots?: readonly string[] }) {
  useDismissOnSelection(props.nonce, props.dismiss);
  return createElement("span", null, (props.bots ?? []).join(","));
}

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(element: ReturnType<typeof createElement>) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root!.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("useDismissOnSelection", () => {
  it("does not dismiss on mount, whatever the first nonce is", () => {
    const dismiss = vi.fn();
    render(createElement(Probe, { nonce: 7, dismiss }));
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss when the store changes without a pick", () => {
    const dismiss = vi.fn();
    render(createElement(Probe, { nonce: 3, dismiss, bots: ["a"] }));
    // A streamed bot update, a new room, a thread pin: the nonce stays put and
    // the owner hands in a fresh closure every time.
    render(createElement(Probe, { nonce: 3, dismiss: () => dismiss(), bots: ["a", "b"] }));
    render(createElement(Probe, { nonce: 3, dismiss: () => dismiss(), bots: ["b"] }));
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("dismisses once per pick, including a pick of the chat that is already open", () => {
    const dismiss = vi.fn();
    render(createElement(Probe, { nonce: 0, dismiss }));
    render(createElement(Probe, { nonce: 1, dismiss }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    render(createElement(Probe, { nonce: 2, dismiss }));
    expect(dismiss).toHaveBeenCalledTimes(2);
  });

  it("does not fire again when only the callback changes after a pick", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(createElement(Probe, { nonce: 0, dismiss: first }));
    render(createElement(Probe, { nonce: 1, dismiss: first }));
    render(createElement(Probe, { nonce: 1, dismiss: second }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("treats StrictMode's mount replay as a mount, not a pick", () => {
    const dismiss = vi.fn();
    render(createElement(StrictMode, null, createElement(Probe, { nonce: 4, dismiss })));
    expect(dismiss).not.toHaveBeenCalled();
    render(createElement(StrictMode, null, createElement(Probe, { nonce: 5, dismiss })));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

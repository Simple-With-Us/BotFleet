// The pairing page's own copy about a refused signing key.
//
// A page that tells an operator to replace a file the sidecar never reads
// sends them nowhere: the key lives in the vault, so replacing a local file
// leaves the verdict exactly where it was and the pushes stay off.  The
// remedy therefore has to name the source the key actually lives in.
//
// These tests drive the SERVED page rather than the source of a helper in
// it.  A helper-only assertion cannot catch a leak: the helper can be
// correct while the page never calls it, which is exactly the shape of
// bug this file exists to prevent.  So the whole module script is extracted
// from the HTML the server sends and run here against a stub DOM, and the
// assertions are on the string that lands in the DOM.
import { describe, expect, it } from "vitest";

import { page } from "../src/control.ts";

/** The page's script, as the browser would receive it. */
const scriptOf = (html: string): string => {
  const match = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("the pairing page has no module script");
  return match[1];
};

/** A DOM stub with just enough surface for the page's script: the elements
 *  it writes into, and a `querySelectorAll` that finds no buttons (this
 *  suite is about the copy, not about the click handlers).
 *
 *  The map holds what the page wrote, and a DOM lets a page write something
 *  that is not a string, so the map is typed to allow that: the guards have
 *  to catch it rather than the type system doing it for them. */
const stubDom = () => {
  const written = new Map<string, string | null>();
  const nodes = new Map<string, { innerHTML: string; addEventListener: () => void }>();
  const element = (id: string) => {
    const node = {
      innerHTML: "",
      addEventListener: () => {},
    };
    Object.defineProperty(node, "innerHTML", {
      get: () => written.get(id) ?? "",
      set: (value: string | null) => written.set(id, value),
    });
    nodes.set(id, node);
    return node;
  };
  return {
    written,
    document: {
      getElementById: (id: string) => nodes.get(id) ?? element(id),
      querySelectorAll: () => [],
    },
  };
};

/** The push health the page draws, in the shape the sidecar sends it. */
interface PagePush {
  keyRejected?: string;
  lastError?: string;
  lastErrorAt?: number;
  lastErrorCode?: string;
  configured: boolean;
  tokensRegistered: number;
  sent?: number;
  failed?: number;
  dropped: number;
  circuitDropped?: number;
  consecutiveTransportFailures?: number;
  circuitOpenUntil?: number;
  failureKind?: string;
  pushesOff?: boolean;
  pushesOffReason?: string;
  lastSentAt?: number;
}

/** A paired phone, in the shape the page draws it. */
interface PageDevice {
  id: string;
  name: string;
  lastSeenAt: number;
  cloudDesktopAccess: boolean;
}

/** The state the control plane serves, in the shape the page draws it. */
interface PageState {
  pid: number;
  port: number;
  addresses: string[];
  lan: string | null;
  hosts: string[];
  endpoints: Array<{ kind: string; priority: number; url: string }>;
  lanPolicy: { allowCleartextLan: boolean; note: string };
  pairing: null;
  devices: PageDevice[];
  connectedDeviceIds: string[];
  discovery: { advertising: boolean; name: string };
  push?: PagePush | null;
  keySource?: string;
}

/** A state the page can draw in full.  The page reads every field of the
 *  state the sidecar sends, so a partial one is not a page — it is a
 *  crash.  `push` and `keySource` are the two this suite varies. */
const stateWith = (push: PagePush | null, keySource?: string): PageState => {
  const state: PageState = {
    pid: 4242,
    port: 8810,
    addresses: ["192.168.1.42"],
    lan: "192.168.1.42",
    hosts: ["192.168.1.42:8810"],
    endpoints: [{ kind: "lan", priority: 1, url: "http://192.168.1.42:8810" }],
    lanPolicy: { allowCleartextLan: false, note: "loopback only" },
    pairing: null,
    devices: [],
    connectedDeviceIds: [],
    discovery: { advertising: false, name: "Test computer" },
    push,
  };
  // The source is absent on an older sidecar's state, and the page has to
  // cope with that, so the field is left off rather than set to nothing.
  if (keySource !== undefined) state.keySource = keySource;
  return state;
};

/** Run the page's own `render` over a state object and return what it wrote
 *  into each element.  The script is a module, so it is evaluated as one:
 *  the functions it declares are the ones the browser would call. */
const renderPage = (state: PageState): Map<string, string | null> => {
  const html = page();
  const script = scriptOf(html);
  const dom = stubDom();
  // The trailing `render(await api("/state"))` is the page's own bootstrap:
  // it fetches and draws.  Everything before it is the definition of the
  // functions, which is what this needs.
  const body = script.split("render(await api(\"/state\"));").slice(0, 1).join("");
  const render = new Function(
    "document",
    "fetch",
    `${body}\nreturn render;`,
  );
  const draw = render(dom.document, async () => ({ json: async () => state }));
  draw(state);
  return dom.written;
};

describe("the pairing page's refused-key remedy", () => {
  it("names the source the key actually lives in", () => {
    const written = renderPage(stateWith(
      {
        keyRejected: "InvalidProviderToken",
        lastError: "403 InvalidProviderToken",
        configured: true,
        tokensRegistered: 1,
        dropped: 0,
      },
      "Infisical APNS_KEY_P8",
    ));

    const push = written.get("push") ?? "";
    expect(push).toContain("Replace Infisical APNS_KEY_P8 to turn pushes back on.");
    // The old wording sent an operator to a file this sidecar never reads.
    expect(push).not.toContain("the key file");
    expect(push).not.toContain("Replace the key file");
  });

  it("falls back to the signing key when the sidecar names no source", () => {
    // An older sidecar sent a state without the source, and the page has to
    // say something true in that case rather than naming a file it cannot
    // know about.  A fresh signature from the same key cannot help, so the
    // signing key is what has to change.
    const written = renderPage(stateWith({
      keyRejected: "InvalidProviderToken",
      configured: true,
      tokensRegistered: 1,
      dropped: 0,
    }));

    const push = written.get("push") ?? "";
    expect(push).toContain("Replace the signing key to turn pushes back on.");
    expect(push).not.toContain("the key file");
  });

  it("surfaces Apple's reason next to the remedy", () => {
    const written = renderPage(stateWith(
      {
        keyRejected: "InvalidProviderToken",
        lastError: "403 InvalidProviderToken",
        configured: true,
        tokensRegistered: 1,
        dropped: 0,
      },
      "Infisical APNS_KEY_P8",
    ));

    const push = written.get("push") ?? "";
    expect(push).toContain("Apple refused the signing key");
    expect(push).toContain("InvalidProviderToken");
    expect(push).toContain("403 InvalidProviderToken");
  });

  it("escapes the source name rather than trusting it", () => {
    // The source name reaches the page as data.  A name carrying markup must
    // not become markup: this is the one string on the page that came from
    // somewhere else.
    const written = renderPage(stateWith(
      {
        keyRejected: "InvalidProviderToken",
        configured: true,
        tokensRegistered: 1,
        dropped: 0,
      },
      "<script>alert(1)</script>",
    ));

    const push = written.get("push") ?? "";
    expect(push).not.toContain("<script>alert(1)</script>");
    expect(push).toContain("&lt;script&gt;");
  });

  it("never tells the reader to replace a key file, in any state", () => {
    // The whole class of bug, checked against every state the page can be
    // in.  A sweep of the source is not enough on its own: the page builds
    // its copy from several branches, and one of them can still be wrong.
    const states = [
      stateWith({ keyRejected: "InvalidProviderToken", configured: true, tokensRegistered: 1, dropped: 0 }),
      stateWith({ keyRejected: "InvalidProviderToken", configured: true, tokensRegistered: 1, dropped: 0 }, "Infisical APNS_KEY_P8"),
      stateWith({ configured: false, tokensRegistered: 0, dropped: 0 }),
      stateWith({ configured: true, tokensRegistered: 2, sent: 3, dropped: 0 }),
      stateWith({ configured: true, tokensRegistered: 0, sent: 0, failed: 1, dropped: 0, lastError: "ECONNRESET" }),
      stateWith(null),
      // An older sidecar sends no push field at all.
      { ...stateWith(null), push: undefined },
    ];

    for (const state of states) {
      const written = renderPage(state);
      // The sweep below only sees what the page wrote, so a page that
      // rendered nothing — or one that rendered blank panels — would pass it
      // for free: blank copy cannot be wrong copy.  Prove first that every
      // panel the sweep is about to inspect carries real content, or a broken
      // page state would slip through as silence.
      //
      // The type check is deliberate and is not the same as `toBeDefined()`:
      // a panel the page wrote as null is defined, so a definedness check
      // would wave it through.
      for (const [id, html] of written) {
        expect(html, `element ${id} was not rendered as a string`).toBeTypeOf("string");
        expect((html ?? "").trim().length, `element ${id} rendered blank`).toBeGreaterThan(0);
      }
      // And the page is made of these four panels, so each one has to be
      // there at all.
      for (const id of ["where", "pair", "devices", "push"]) {
        expect(written.has(id), `element ${id} was not rendered`).toBe(true);
      }
      for (const [id, html] of written) {
        expect(html, `element ${id}`).not.toContain("the key file");
        expect(html, `element ${id}`).not.toContain("Replace the key file");
      }
    }
  });
});

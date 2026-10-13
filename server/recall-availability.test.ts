import { describe, expect, it } from "vitest";
import { recallAvailableForTurn } from "./recall-transport.ts";

describe("recallAvailableForTurn", () => {
  const settings = (over: Partial<{ url: string; collection: string }> = {}) => ({
    url: "",
    collection: "",
    accessClientId: "",
    accessClientSecret: "",
    apiKey: "",
    ...over,
  });

  it("is false when the operator turned recall off, which the caller resolves first", () => {
    // `enabled: false` is handled where it belongs — the call site does
    // `cfg.qdrant?.enabled !== false ? recallSettings() : undefined`, so the
    // function is handed `undefined`. A `recall` binary in PATH is a fact about
    // this computer, not consent, and it must not resurrect an operator's
    // "off" by being probed downstream.
    expect(recallAvailableForTurn(undefined, true, true)).toBe(false);
  });

  it("is false when a toolLoop-less engine asks", () => {
    // Only an in-process HTTP tool-loop lane can carry the recall tools. A CLI
    // or ACP engine has no host to mount them, so advertising them would invite
    // a model round for a tool that cannot run.
    expect(recallAvailableForTurn(settings({ url: "https://r.example" }), false, true)).toBe(false);
  });

  it("is true for a configured service, with or without a local CLI", () => {
    // An explicit service is never bypassed by a local corpus, so the CLI's
    // presence must not change this.
    expect(recallAvailableForTurn(settings({ url: "https://r.example", collection: "c" }), true, true)).toBe(true);
    expect(recallAvailableForTurn(settings({ url: "https://r.example" }), true, false)).toBe(true);
    // A configured service short-circuits: the probe is never called.
    let probed = false;
    expect(recallAvailableForTurn(settings({ url: "https://r.example" }), true, () => { probed = true; return "/x"; })).toBe(true);
    expect(probed).toBe(false);
  });

  it("is true for a bare local CLI, and that is the case that hid itself", () => {
    // The state this repo was found in: `enabled: true`, `url` and `collection`
    // both empty, and a `recall` binary on this computer. The tools went live
    // and answered from a corpus the owner never pointed the app at, while
    // /api/qdrant/status reported `configured: true`. Availability is
    // therefore NOT a statement about WHICH corpus — that is what
    // `configuredTarget` on the status exists to say.
    expect(recallAvailableForTurn(settings(), true, true)).toBe(true);
    // A thunk works identically, and is what the call site passes so the
    // binary is not probed when recall is off.
    expect(recallAvailableForTurn(settings(), true, () => "/usr/local/bin/recall")).toBe(true);
  });

  it("is false when nothing can answer — no URL and no CLI", () => {
    // The one combination that is unambiguous, and the one a test pins: a
    // machine with no `recall` binary and no configured service must not be
    // handed the tools. This expression was inline in index.ts and untested,
    // which is how the misconfigured-but-\"configured\" state went unnoticed.
    expect(recallAvailableForTurn(settings(), true, false)).toBe(false);
    expect(recallAvailableForTurn(settings(), true, () => null)).toBe(false);
    expect(recallAvailableForTurn(undefined, true, false)).toBe(false);
  });

});

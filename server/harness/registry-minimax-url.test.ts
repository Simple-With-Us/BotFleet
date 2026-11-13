// registry.ts has to know where a MiniMax instance's TURNS go before it can
// ask that host for the account's quota, and MinimaxDriver.create() keeps its
// own DEFAULT_URL constant private.  registry.ts therefore mirrors the value
// as MINIMAX_DEFAULT_URL — and this file pins the mirror against the driver's
// own observable behavior so the two cannot drift apart silently.
//
// Deliberately a separate file from registry.test.ts: that one mocks
// ../drivers/minimax.ts module-wide, which is exactly what this file must not
// do.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodeMinimaxConfig, loadLocalMiniMaxConfig } from "../drivers/minimax.ts";
import { MINIMAX_DEFAULT_URL, resolveMinimaxApiUrl } from "./registry.ts";

const CN_URL = "https://api.minimaxi.com/v1";

describe("MINIMAX_DEFAULT_URL mirrors the driver's own default", () => {
  it("matches the host loadLocalMiniMaxConfig falls back to with no ~/.mmx/config.json", () => {
    // mkdtemp rather than a hardcoded path: OS-neutral, and guaranteed not
    // to contain a .mmx config that would change the answer.
    const home = mkdtempSync(join(tmpdir(), "botfleet-mmx-"));
    try {
      expect(loadLocalMiniMaxConfig(home).url).toBe(MINIMAX_DEFAULT_URL);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("matches the host decodeMinimaxConfig falls back to for an instance with no url of its own", () => {
    const previous = process.env.MINIMAX_BASE_URL;
    delete process.env.MINIMAX_BASE_URL;
    try {
      expect(decodeMinimaxConfig({}).url).toBe(MINIMAX_DEFAULT_URL);
      expect(decodeMinimaxConfig(undefined).url).toBe(MINIMAX_DEFAULT_URL);
    } finally {
      if (previous === undefined) delete process.env.MINIMAX_BASE_URL;
      else process.env.MINIMAX_BASE_URL = previous;
    }
  });
});

describe("resolveMinimaxApiUrl", () => {
  // Built through the driver's REAL decoder, so the provenance this helper
  // branches on is the provenance the driver itself computed — the mirror
  // cannot drift from the original by construction.
  const cfg = (raw: unknown) => decodeMinimaxConfig(raw);

  // MINIMAX_BASE_URL is one of the decoder's own inputs, so a shell that
  // happens to export it would otherwise change every answer below.
  let previousBaseUrl: string | undefined;
  beforeEach(() => {
    previousBaseUrl = process.env.MINIMAX_BASE_URL;
    delete process.env.MINIMAX_BASE_URL;
  });
  afterEach(() => {
    if (previousBaseUrl === undefined) delete process.env.MINIMAX_BASE_URL;
    else process.env.MINIMAX_BASE_URL = previousBaseUrl;
  });

  it("hands the reserved instance the local mmx host while nothing has chosen one", () => {
    expect(resolveMinimaxApiUrl("minimax", cfg({}), CN_URL)).toBe(CN_URL);
  });

  it("keeps the reserved instance's own host once it configures one", () => {
    expect(resolveMinimaxApiUrl("minimax", cfg({ url: "https://gateway.example/v1" }), CN_URL))
      .toBe("https://gateway.example/v1");
  });

  it("keeps a host chosen in Settings even when that host IS the global default", () => {
    // The case a value comparison gets wrong: `urlSource: "workspace"` is the
    // stamp instanceConfigs() writes on a url it resolved from the Settings
    // row, and the string it resolved to is byte-identical to the unset one.
    // Without provenance the balance lookup asked api.minimaxi.com while the
    // turns billed api.minimax.io — the exact drift this file exists to stop.
    expect(resolveMinimaxApiUrl("minimax", cfg({ url: MINIMAX_DEFAULT_URL, urlSource: "workspace" }), CN_URL))
      .toBe(MINIMAX_DEFAULT_URL);
  });

  it("leaves the reserved instance on the global default when the local mmx config agrees", () => {
    expect(resolveMinimaxApiUrl("minimax", cfg({}), MINIMAX_DEFAULT_URL)).toBe(MINIMAX_DEFAULT_URL);
  });

  it("never lets the machine-wide mmx host reach a second connection", () => {
    // ~/.mmx/config.json is one file for the whole machine, so its host is a
    // workspace default the driver hands only to the reserved instance.
    expect(resolveMinimaxApiUrl("secondMinimax", cfg({}), CN_URL)).toBe(MINIMAX_DEFAULT_URL);
  });
});

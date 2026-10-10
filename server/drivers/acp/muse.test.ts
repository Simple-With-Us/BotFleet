// Muse Code driver.  The engine runs on a community ACP adapter in front of
// Meta's `muse serve`, so the things worth pinning here are the claims that
// shape what a user gets: which channels the engine mounts, which model the
// picker offers, and which effort rungs we advertise.  Each one is a place
// where an optimistic edit would overclaim a capability the engine does not
// actually have.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import {
  MUSE_EFFORT_LEVELS,
  MUSE_LOGIN_NOTE,
  MuseAgentDriver,
  STATIC_MUSE_MODELS,
  museAuthenticated,
} from "./muse.ts";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "botfleet-muse-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Muse Code driver", () => {
  it("is registered as a built-in driver", () => {
    // A driver file nobody imports is a file that does nothing, and the
    // capability matrix would have a row for an engine that cannot start.
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "museAgent")).toBe(true);
  });

  it("mounts every MCP channel and takes images", () => {
    // The adapter forwards the MCP servers BotFleet hands `session/new` into
    // Muse through a private overlay, and takes PNG/JPEG/GIF/WebP image parts
    // on a turn.  Both are the reason this engine can have Connected Apps at
    // all, so they are pinned rather than inferred.
    expect(MuseAgentDriver.metadata.channelWiring).toEqual({
      agentsMcp: true,
      computerMcp: true,
      composioMcp: true,
      localComputerMcp: true,
      images: true,
    });
  });

  it("names itself Muse Code and the CLI it actually spawns", () => {
    expect(MuseAgentDriver.driverKind).toBe("museAgent");
    expect(MuseAgentDriver.metadata.displayName).toBe("Muse Code");
    // The spawned binary is the adapter, never `muse` itself: `muse` speaks
    // MSP, and the adapter is what speaks ACP to us.
    const decoded = MuseAgentDriver.defaultConfig();
    expect((decoded as { cli: string }).cli).toBe("muse-code-acp");
  });

  it("installs both halves — the muse binary and the adapter", () => {
    const install = MuseAgentDriver.install;
    expect(install?.needsNode, "npm install -g needs Node on PATH").toBe(true);
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const command = install?.command?.[platform] ?? "";
      expect(command, platform).toContain("muse-code-acp");
    }
    // The Windows chain is PowerShell's `;`, not `&&` — a shell mismatch here
    // would install the adapter and skip the binary (or the reverse) and the
    // user would only find out on their first turn.
    expect(install?.command?.win32).toContain("npm install -g @bex-co/muse-code-acp");
    expect(install?.signInCommand).toBe("muse auth set --provider meta --api-key-stdin");
  });

  it("offers the CLI's own default model, not the best model on the card", () => {
    // muse-spark-1.3 is "tuned for agentic workflows" and is the Model API
    // default, but the CLI defaults to 1.2 and no model switch is wired yet,
    // so listing 1.3 would put a row in the picker a user can select and
    // cannot get.
    expect(STATIC_MUSE_MODELS.default).toBe("muse-spark-1.2");
    expect(STATIC_MUSE_MODELS.options.map((option) => option.id)).toEqual(["muse-spark-1.2"]);
    const only = STATIC_MUSE_MODELS.options[0];
    expect(only?.contextWindow).toBe(1_048_576);
    expect(only?.images).toBe(true);
  });

  it("advertises only the effort rungs it can actually send", () => {
    // `none` is excluded because the Meta provider rejects it (HTTP 400).
    // `max` is excluded because it is muse-spark-1.3 only and 1.3 is not a
    // model this driver offers.  `minimal` and `ultra` are absent because the
    // shared EFFORT_LEVELS union has no member for them, and widening that
    // union would put two rungs in pi's picker that pi does not take.  All
    // four omissions are deliberate, and each one is a rung the picker must
    // not offer rather than a rung that quietly fails on the first turn.
    expect(MUSE_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh"]);
    expect(MUSE_EFFORT_LEVELS).not.toContain("none");
    expect(MUSE_EFFORT_LEVELS).not.toContain("max");
    // Guard the reason itself: if 1.3 ever enters the catalog, `max` becomes
    // reachable and this assertion is the reminder to put it back.
    expect(STATIC_MUSE_MODELS.options.map((option) => option.id)).not.toContain("muse-spark-1.3");
  });

  it("treats META_API_KEY as proof of a sign-in", () => {
    // The key wins over a stored browser session, so it is the one signal
    // worth trusting.  Its value is never read.
    expect(museAuthenticated({ META_API_KEY: "set" })).toBe(true);
    expect(museAuthenticated({ META_API_KEY: "   " })).toBe(false);
  });

  it("accepts a keychain session, because the CLI resolves it for the adapter", () => {
    // Every fixture goes where the REAL index lives — `$HOME/.config/muse/`,
    // not `dir/auth.json` — so these are genuine regression guards.  The first
    // version of this test wrote elsewhere and passed for the wrong reason:  an
    // implementation reading the file would not have found it.
    const keychainHome = scratch();
    const keychainDir = join(keychainHome, ".config", "muse");
    mkdirSync(keychainDir, { recursive: true });
    writeFileSync(
      join(keychainDir, "auth.json"),
      // The observed macOS shape:  an index with no credential in it, naming
      // the keychain as the place the token went.
      JSON.stringify({
        schema_version: 1,
        providers: {
          meta: {
            mechanism: "oauth",
            storage: "keychain",
            obtained_via: "device_code",
            api_base_url: "https://api.meta.ai/v1",
          },
        },
      }),
      "utf8",
    );

    // A keychain-backed browser session is a real credential.  This used to
    // assert `false`, on the theory that the adapter's bundled
    // `@muse-code/sdk@1.3.0` predates the keychain move.  Measured against the
    // real `muse-code-acp` on this exact account shape:  initialize, session/new
    // and session/prompt all succeed and the prompt returns `end_turn`.  The
    // adapter spawns `muse serve`; the installed CLI is what reads the token,
    // so the SDK version never mattered.  Answering `false` here stranded the
    // setup card and the failover chain for a user who was signed in and could
    // run a turn by hand.
    expect(museAuthenticated({ HOME: keychainHome })).toBe(true);
    expect(
      museAuthenticated({ HOME: keychainHome, MUSE_AUTH_PATH: join(keychainDir, "auth.json") }),
    ).toBe(true);

    // A file-backed credential is the NORMAL case on Linux and Windows, where
    // there is no macOS Keychain to put it in.  Treating that as "not signed
    // in" would strand every user on those platforms, so `storage` is the
    // discriminator and only `keychain` is unproven.
    const fileHome = scratch();
    const fileDir = join(fileHome, ".config", "muse");
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(
      join(fileDir, "auth.json"),
      JSON.stringify({
        schema_version: 1,
        providers: {
          meta: { mechanism: "api_key", storage: "file", api_base_url: "https://api.meta.ai/v1" },
        },
      }),
      "utf8",
    );
    expect(museAuthenticated({ HOME: fileHome })).toBe(true);

    // No index at all is plainly not signed in.
    expect(museAuthenticated({ HOME: scratch() })).toBe(false);
    // And the env key outranks everything.
    expect(museAuthenticated({ META_API_KEY: "set", HOME: keychainHome })).toBe(true);
    // A malformed index must not throw out of a snapshot path.
    const brokenHome = scratch();
    const brokenDir = join(brokenHome, ".config", "muse");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "auth.json"), "{ not json", "utf8");
    expect(museAuthenticated({ HOME: brokenHome })).toBe(false);
  });

  it("only counts a credential under the provider this driver actually spends", () => {
    // The index is a map of *providers*.  The check used to return the first
    // provider carrying any `storage`, so an index holding only some other
    // provider reported the engine as signed in — and `turn-safety.ts` then
    // put that unauthenticated instance into the failover chain, where it
    // would fail every turn before the chain ever got a real shot.
    const otherHome = scratch();
    const otherDir = join(otherHome, ".config", "muse");
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      join(otherDir, "auth.json"),
      JSON.stringify({
        schema_version: 1,
        providers: { someotherprovider: { mechanism: "api_key", storage: "keychain" } },
      }),
      "utf8",
    );
    expect(museAuthenticated({ HOME: otherHome })).toBe(false);

    // Both present: `meta` is the one that counts, and it satisfies the check
    // on its own.  `meta` must win even when the other provider sorts first.
    writeFileSync(
      join(otherDir, "auth.json"),
      JSON.stringify({
        schema_version: 1,
        providers: {
          aaaother: { mechanism: "api_key", storage: "keychain" },
          meta: { mechanism: "browser_session", storage: "keychain" },
        },
      }),
      "utf8",
    );
    expect(museAuthenticated({ HOME: otherHome })).toBe(true);

    // A `meta` entry with no storage is not a credential either.
    writeFileSync(
      join(otherDir, "auth.json"),
      JSON.stringify({ schema_version: 1, providers: { meta: { mechanism: "none" } } }),
      "utf8",
    );
    expect(museAuthenticated({ HOME: otherHome })).toBe(false);
  });

  it("survives an index whose shape is not what the schema expects", () => {
    // The index is a file another program writes, so its shape is not ours to
    // assume.  Every one of these is valid JSON that would have indexed into
    // nonsense before the schema, and each must read as "not signed in"
    // rather than throwing out of a snapshot path or, worse, reporting a
    // credential that is not there.
    const home = scratch();
    const dir = join(home, ".config", "muse");
    mkdirSync(dir, { recursive: true });
    const cases = [
      '"just a string"',
      "42",
      "null",
      "[]",
      JSON.stringify({ providers: "not-an-object" }),
      JSON.stringify({ providers: { meta: "not-an-object" } }),
      JSON.stringify({ providers: { meta: { storage: 42 } } }),
      JSON.stringify({ providers: { meta: { storage: "" } } }),
      JSON.stringify({ providers: { meta: { storage: null } } }),
    ];
    for (const body of cases) {
      writeFileSync(join(dir, "auth.json"), body, "utf8");
      expect(museAuthenticated({ HOME: home }), `index ${body.slice(0, 40)}`).toBe(false);
    }

    // An unmodelled provider alongside a good `meta` one still signs in —
    // `.passthrough()` exists so a future provider cannot invalidate the file.
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({
        providers: { futureprovider: { storage: "file", somethingNew: 1 }, meta: { storage: "keychain" } },
      }),
      "utf8",
    );
    expect(museAuthenticated({ HOME: home })).toBe(true);
  });

  it("names the same sign-in path the auth check can actually see", () => {
    // The bug this guards:  `loginNote` and `signInCommand` pointed at
    // `muse-code-acp --cli login`, which completes a device-code session into
    // the keychain — a credential this engine cannot read.  A user who followed
    // the card exactly stayed `authenticated: false` forever, the setup card
    // never cleared, and `turn-safety.ts` kept the instance out of the failover
    // chain.  If the two ever drift apart again, the card stops working.
    const signIn = MuseAgentDriver.install?.signInCommand ?? "";
    expect(signIn).toBe("muse auth set --provider meta --api-key-stdin");
    expect(signIn).not.toContain("--cli login");
    expect(MUSE_LOGIN_NOTE).toContain("API key");
    // The command reads the key from stdin, so it BLOCKS.  Without the key and
    // the EOF named in the note, a user following the setup card sits in a
    // terminal that looks hung and the card never clears.
    expect(MUSE_LOGIN_NOTE).toContain("--api-key-stdin");
    expect(MUSE_LOGIN_NOTE).toMatch(/paste the key/i);
    expect(MUSE_LOGIN_NOTE).toMatch(/ctrl-d/i);
  });
});

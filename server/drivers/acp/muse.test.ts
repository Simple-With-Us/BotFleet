// Muse Code driver.  The engine runs on a community ACP adapter in front of
// Meta's `muse serve`, so the things worth pinning here are the claims that
// shape what a user gets: which channels the engine mounts, which model the
// picker offers, and which effort rungs we advertise.  Each one is a place
// where an optimistic edit would overclaim a capability the engine does not
// actually have.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "../builtIn.ts";
import {
  MUSE_EFFORT_LEVELS,
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
    expect(install?.signInCommand).toBe("muse-code-acp --cli login");
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
    // `minimal` and `ultra` are absent because the shared EFFORT_LEVELS union
    // has no member for them, and widening that union would put two rungs in
    // pi's picker that pi does not take.  Both are deliberate.
    expect(MUSE_EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(MUSE_EFFORT_LEVELS).not.toContain("none");
  });

  it("treats META_API_KEY as proof of a sign-in", () => {
    // The key wins over a stored browser session, so it is the one signal
    // worth trusting.  Its value is never read.
    expect(museAuthenticated({ META_API_KEY: "set" })).toBe(true);
    expect(museAuthenticated({ META_API_KEY: "   " })).toBe(false);
  });

  it("falls back to the stored auth file, and never reads the credential", () => {
    const dir = scratch();
    const authPath = join(dir, "auth.json");
    expect(museAuthenticated({ MUSE_AUTH_PATH: authPath })).toBe(false);
    writeFileSync(authPath, JSON.stringify({ token: "super-secret-value" }), "utf8");
    expect(museAuthenticated({ MUSE_AUTH_PATH: authPath })).toBe(true);
  });
});

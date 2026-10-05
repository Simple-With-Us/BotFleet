// trackCliGroup: a CLI's process group is signalled only while `-pid` can
// still be shown to name it.  Real children (node one-liners), POSIX only:
// Windows has no process groups and trackCliGroup never signals there.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLI_GROUP_WATCH_MS, spawnCli, trackCliGroup } from "./procs.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const posix = describe.skipIf(process.platform === "win32");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

posix("trackCliGroup", () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const fn of cleanup.splice(0)) await fn();
  });

  /** Spawn a leader the way drivers do (detached, so it leads its own group). */
  const leader = (script: string) => {
    const child = spawnCli(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    cleanup.push(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    });
    return child;
  };
  const exited = (child: ReturnType<typeof leader>) =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });

  it("owns the group while the leader is alive", async () => {
    const child = leader("setInterval(() => {}, 1000)");
    const group = trackCliGroup(child);
    expect(group.owned).toBe(true);
    expect(group.signal("SIGTERM")).toBe(true);
    await exited(child);
  });

  it("never signals the group id once the leader exited with nothing left in it", async () => {
    // Kody #831: the leader is reaped, its group is empty, so its pid is free
    // for the OS to recycle into an unrelated group.  No signal may go to it.
    const child = leader("process.exit(0)");
    const group = trackCliGroup(child);
    const pid = child.pid!;
    await exited(child);
    const kill = vi.spyOn(process, "kill");
    expect(group.owned).toBe(false);
    expect(group.signal("SIGKILL")).toBe(false);
    expect(group.signal("SIGTERM")).toBe(false);
    expect(kill.mock.calls.filter(([target]) => target === -pid)).toEqual([]);
  });

  it("keeps the group while a SIGTERM-ignoring descendant outlives the leader, then lets it go", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-cli-group-"));
    cleanup.push(() => removeTempDir(dir));
    const pidFile = join(dir, "descendant.pid");
    const child = leader(
      [
        "const { spawn } = require('node:child_process');",
        "const d = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(d.pid));`,
        "process.exit(0);",
      ].join(" "),
    );
    const group = trackCliGroup(child);
    await exited(child);
    const descendant = Number(readFileSync(pidFile, "utf8"));
    cleanup.push(() => {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        // reaped by the group kill below
      }
    });
    // The descendant keeps the group (and so the id) alive: still ours.
    expect(alive(descendant)).toBe(true);
    expect(group.owned).toBe(true);
    expect(group.signal("SIGTERM")).toBe(true);
    expect(alive(descendant)).toBe(true); // it ignores SIGTERM
    expect(group.signal("SIGKILL")).toBe(true);
    await vi.waitFor(() => expect(alive(descendant)).toBe(false), { timeout: 2_000 });
    // The watcher sees the group empty and disowns it for good.
    await vi.waitFor(() => expect(group.owned).toBe(false), { timeout: CLI_GROUP_WATCH_MS * 20 });
    const kill = vi.spyOn(process, "kill");
    expect(group.signal("SIGKILL")).toBe(false);
    expect(kill.mock.calls.filter(([target, sig]) => target === -child.pid! && sig !== 0)).toEqual([]);
  });
});

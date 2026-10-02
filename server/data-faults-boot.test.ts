// End to end: boot the real server (node server/index.ts) against a throwaway
// home whose saved data is damaged, and check what the owner would actually
// meet.  The data dir is laid out as it is after an incident and a restart:
//
//   * bots.json is missing and a set-aside bots.json from an earlier run is
//     waiting.  Alone, a missing bots.json reads as a fresh install, so this
//     is the case that used to seed a new Director and strip every room's
//     members on the second boot.
//   * routines.json holds something that is not a routines file (a fresh
//     incident, found by the running server).
//   * config.json has a good section and two bad ones.
//
// The server must start, keep every byte it set aside, say so on
// GET /api/data-faults, and leave the rooms alone.  The truncated-bots path
// and the second boot are covered file by file in store-quarantine.test.ts.
//
// The port comes from a probed free block and the data lives under a temp
// HOME; nothing here touches port 8799 or the real ~/.botfleet.
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

interface Fault {
  file: string;
  kind: string;
  reason: string;
  setAsideAs: string | null;
  sections: string[];
  holdsCleanup: boolean;
}

let home: string;
let data: string;
let child: ChildProcess | undefined;
let stdout = "";
let stderr = "";
let portBase = 0;

const base = () => `http://127.0.0.1:${portBase}`;
const get = async (path: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base()}${path}`);
  return { status: res.status, body: await res.json() };
};
/** True once /api/health answers and says it has finished booting.  The port is bound before the boot
 * work, so a bare 200 is too early: until then every other route answers 503. */
const serverReady = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${base()}/api/health`);
    const health = z.object({ ready: z.boolean().optional() }).safeParse(await res.json());
    return res.ok && (!health.success || health.data.ready !== false);
  } catch {
    return false;
  }
};
const aside = (store: string): string[] => readdirSync(data).filter((name) => name.startsWith(`${store}.corrupt-`)).sort();

describe("a server booted over damaged saved data", () => {
  const earlierRoster = '[{"id":"bot-1","name":"Lead","threadId":"t-1","createdAt":1},{"id":"bo';
  const earlierName = "bots.json.corrupt-1790000000000";
  const groups = JSON.stringify([
    {
      id: "room-1",
      threadId: "room-thread",
      name: "Ops",
      memberIds: ["bot-1", "bot-2"],
      defaultResponder: { kind: "member", botId: "bot-1" },
      bulletin: "",
      unread: false,
      createdAt: 1,
    },
  ]);
  const routines = '["not","a","routines","file"]';

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-data-faults-boot-"));
    data = join(home, ".botfleet");
    const staticDir = join(home, "static");
    mkdirSync(data, { recursive: true });
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>BotFleet</title>");
    writeFileSync(join(data, earlierName), earlierRoster);
    writeFileSync(join(data, "groups.json"), groups);
    writeFileSync(join(data, "routines.json"), routines);
    // The only engine is a driver that does not exist, so the boot probes nothing and spawns nothing.
    writeFileSync(
      join(data, "config.json"),
      JSON.stringify({
        instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } },
        profile: { name: "Ada" },
        autoUpdate: { enabled: "yes" },
        tts: { key: ["sk-fixture-secret-value"] },
      }),
    );

    portBase = await freePortBlock([0, 1]);
    // An empty directory rather than a hardcoded "/usr/bin:/bin", which does
    // not exist on Windows.  The server resolves `git` at startup through
    // readSourceBuildIdentity, so a PATH naming no such directory there made
    // the child exit 1 before it ever read the damaged data.  An empty folder
    // hides engine CLIs the same way on every platform, and the server is
    // started by absolute path so it does not need one to be found.
    const emptyBin = join(home, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        // No engine CLI is on this PATH either.
        PATH: emptyBin,
        HOME: home,
        USERPROFILE: home,
        OMB_PORT: String(portBase),
        OMB_WEBHOOK_PORT: String(portBase + 1),
        OMB_STATIC_DIR: staticDir,
        OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (await serverReady()) break;
      if (Date.now() > deadline) throw new Error(`server never came up. stdout:\n${stdout}\nstderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stdout:\n${stdout}\nstderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 180_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  }, 30_000);

  it("reports what it set aside, what it left in place, and what it could only partly read", async () => {
    const [routinesAside] = aside("routines.json");
    expect(aside("routines.json")).toHaveLength(1);
    expect(readFileSync(join(data, routinesAside!), "utf8")).toBe(routines);
    expect(readFileSync(join(data, earlierName), "utf8")).toBe(earlierRoster);

    const { status, body } = await get("/api/data-faults");
    expect(status).toBe(200);
    const faults: Fault[] = body.faults;
    const byFile = new Map(faults.map((fault) => [fault.file, fault]));
    expect(byFile.get("bots.json")).toMatchObject({ kind: "left-over", setAsideAs: earlierName, holdsCleanup: true });
    expect(byFile.get("routines.json")).toMatchObject({ kind: "set-aside", setAsideAs: routinesAside });
    expect(byFile.get("config.json")).toMatchObject({ kind: "config-partial" });
    expect(byFile.get("config.json")?.sections.sort()).toEqual(["autoUpdate", "tts"]);
    expect(byFile.has("groups.json")).toBe(false);

    // Nothing the app is told gives away a path or a fragment of a file.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(home);
    expect(wire).not.toContain("sk-fixture");
    expect(wire).not.toContain("Lead");
  }, 30_000);

  it("does not treat the missing bots.json as a fresh install", async () => {
    const { body } = await get("/api/bots");
    expect(body.bots).toEqual([]); // no Director was seeded
    expect(body.groups.map((group: { id: string }) => group.id)).toEqual(["room-1"]);
    // The API only lists members that exist; what matters is that the file on disk keeps them all.
    // (The Store normalises an older room on load, so the bytes differ; the members must not.)
    const onDisk: Array<{ id: string; memberIds: string[] }> = JSON.parse(readFileSync(join(data, "groups.json"), "utf8"));
    expect(onDisk.map((group) => [group.id, group.memberIds])).toEqual([["room-1", ["bot-1", "bot-2"]]]);
    expect(readdirSync(data)).not.toContain("bots.json");
  }, 30_000);

  it("logs what it did, in words, without the contents of any file", () => {
    expect(stderr).toContain("routines.json could not be used because");
    expect(stderr).toContain("Nothing was deleted");
    expect(stderr).toContain("config.json has settings BotFleet could not use");
    expect(stderr).not.toContain("sk-fixture");
    expect(stdout).not.toContain("sk-fixture");
  });
});

// Room turns on the CLI/ACP lane: a bot's computers, and the approvals that
// make mounting them honest.
//
// `runGroupMemberTurn` used to assign exactly four integrations — agents,
// phone, composio and qdrant — and nothing else.  `integrations.computer`,
// `integrations.computers` and `integrations.localComputer` were never set,
// so a Claude, Codex, Antigravity, pi or ACP bot holding Cua, a Box, a Local
// VM or a VPS in a direct chat lost every one of them the moment it spoke in
// a room.  The HTTP lane in that same room kept host `bash`, because the
// function did compute `hasHostComputer` and hand it to `buildTurnTools` —
// so the weaker lane was the better-equipped one.
//
// The fix raises the CLI lane rather than lowering the HTTP one: both
// dispatchers now call `resolveTurnComputerMounts` and `applyComputerMounts`
// from server/computer-grants.ts.  These tests pin both halves of that — the
// policy, with injected seams, and the wiring, on the real harness.
//
// The engine here is `server/testing/fake-acp-cli.ts`, which dumps the
// `mcpServers` array it was handed at `session/new`; the computer is a
// managed container reached through a fake `docker` on OMB_EXTRA_PATH, the
// same fixture `server/vps-routing.test.ts` uses for the 1:1 lane.  A host
// Cua mount would have been simpler and is deliberately not used: reading a
// real connection descriptor is macOS-only in practice, and these tests have
// to run on Ubuntu too.
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyComputerMounts,
  resolveTurnComputerMounts,
  type ComputerMount,
  type TurnComputerDeps,
} from "./computer-grants.ts";
import { VPS_DEFAULT_CPUS, VPS_DEFAULT_MEMORY_GIB, type AppConfig } from "./config.ts";
import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "./container-computer.ts";
import {
  VPS_CONTAINER_LABEL,
  VPS_IMAGE,
  VPS_MANAGED_LABEL,
  VPS_VIEWER_LABEL,
  vpsContainerName,
} from "./vps-computer.ts";
import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const CONTAINER_ID = "d".repeat(64);
const posixOnly = describe.skipIf(process.platform === "win32");

/* ── the policy, with every seam injected ─────────────────────────────── */

/** A Cua Driver descriptor shaped like the real one, with nothing behind it.
 * The resolver only ever passes it through. */
const HOST_STDIO: NonNullable<ComputerMount["stdio"]> = {
  command: "/fake/cua-driver",
  args: ["mcp"],
  env: { FAKE: "1" },
  scope: "local-computer",
};

/** Deps that refuse every remote destination, so a test that grants only
 * "local" cannot accidentally be answered by a box. */
function stubDeps(
  overrides: Partial<TurnComputerDeps<{ id: string }>> = {},
): TurnComputerDeps<{ id: string }> & { notices: string[] } {
  const notices: string[] = [];
  const unreachable = (): never => {
    throw new Error("this destination should not have been reached");
  };
  return {
    notices,
    hostPlatform: "darwin",
    readHostConnection: () => HOST_STDIO,
    acquireLocalVm: unreachable,
    vps: {
      vpsDriverError: () => null,
      vpsComputerAction: unreachable,
      inspectVpsForAuto: unreachable,
      vpsComputerMcp: unreachable,
      vpsComputerScreenshot: unreachable,
    },
    box: {
      boxConfigured: () => false,
      findBox: async () => null,
      provisionBox: unreachable,
      readyBox: async () => null,
      screenshotBox: unreachable,
    },
    vpsLeases: { claim: () => ({ id: "lease" }), release: () => {} },
    controlIntegration: () => ({ url: "http://127.0.0.1:1/", token: "fake-control-value" }),
    broadcast: () => {},
    notice: (name) => notices.push(name),
    checkpoint: async () => true,
    ...overrides,
  };
}

/** An ACP engine: brokers host asks, so `server/contracts.ts` lets it mount
 * the person's own desktop. */
const ACP_ENGINE = { driverKind: "grokAgent", computerMcp: true, localComputerMcp: true, toolLoop: false };

// SAFETY: the resolver reads only `botDefaults` and `box`, both optional,
// and these cases grant neither a box nor a workspace default.
const EMPTY_CONFIG = {} as AppConfig;

describe("the grant a turn resolves is the same on both lanes", () => {
  it("gives a granted bot its host computer, and hands it to the driver", async () => {
    const deps = stubDeps();
    const resolved = await resolveTurnComputerMounts({
      bot: { id: "bot-1", name: "Hands", computers: ["local"] },
      cfg: EMPTY_CONFIG,
      engine: ACP_ENGINE,
      threadId: "thread-1",
      dispatchId: 1,
      allowed: null,
      deps,
    });
    expect(resolved.cancelled).toBe(false);
    expect(resolved.hasHostComputer).toBe(true);
    expect(resolved.mounts).toEqual([
      { name: "computer", label: "This Mac", kind: "local", stdio: HOST_STDIO },
    ]);

    const integrations: Parameters<typeof applyComputerMounts>[0] = {};
    applyComputerMounts(integrations, resolved.mounts);
    expect(integrations.computers).toEqual(resolved.mounts);
    expect(integrations.localComputer).toEqual(HOST_STDIO);
  });

  it("gives an explicitly emptied grant no computer at all", async () => {
    const deps = stubDeps();
    const resolved = await resolveTurnComputerMounts({
      bot: { id: "bot-2", name: "Deskless", computers: [] },
      cfg: EMPTY_CONFIG,
      engine: ACP_ENGINE,
      threadId: "thread-2",
      dispatchId: 1,
      allowed: null,
      deps,
    });
    expect(resolved.mounts).toEqual([]);
    expect(resolved.hasHostComputer).toBe(false);

    const integrations: Parameters<typeof applyComputerMounts>[0] = {};
    applyComputerMounts(integrations, resolved.mounts);
    expect(integrations.computers).toBeUndefined();
    expect(integrations.computer).toBeUndefined();
    expect(integrations.localComputer).toBeUndefined();
  });

  it("populates the legacy single-computer fields, for drivers that read only those", async () => {
    // Several drivers never look at `integrations.computers`.  Antigravity's
    // `antigravityMcpServers` matches on a `command` key or the legacy box
    // computer, so a mount that arrived only in the array would be invisible
    // to it.  `startTurn` always set `computer` and `localComputer` beside
    // the array; the room lane now goes through the same function, so it
    // cannot set one without the others.
    const box: ComputerMount = {
      name: "",
      label: "ASCII.dev Box",
      kind: "box",
      box: { kind: "box", boxId: "box-1", token: "fake-box-value" },
    };
    const host: ComputerMount = { name: "", label: "This Mac", kind: "local", stdio: HOST_STDIO };

    const integrations: Parameters<typeof applyComputerMounts>[0] = {};
    applyComputerMounts(integrations, [box, host]);
    expect(integrations.computers).toEqual([box, host]);
    expect(integrations.computer).toEqual(box.box);
    expect(integrations.localComputer).toEqual(HOST_STDIO);
  });

  it("withholds the host from an engine with no approval channel, and says why", async () => {
    const deps = stubDeps();
    const resolved = await resolveTurnComputerMounts({
      bot: { id: "bot-3", name: "Mute", computers: ["local"] },
      cfg: EMPTY_CONFIG,
      engine: { ...ACP_ENGINE, localComputerMcp: false },
      threadId: "thread-3",
      dispatchId: 1,
      allowed: null,
      deps,
    });
    expect(resolved.mounts).toEqual([]);
    expect(resolved.hasHostComputer).toBe(false);
    expect(deps.notices.join(" ")).toContain("no approval channel");
  });

  it("releases the VPS turn lease when the destination refuses", async () => {
    // The dispatcher used to hold the lease handle in its own scope, so its
    // catch could give it back.  The claim lives in the resolver now, and a
    // leaked lease freezes that bot's cloud backend — and its sleep and
    // remove actions — until the harness restarts.
    const released: Array<{ id: string }> = [];
    const lease = { id: "vps-lease" };
    const deps = stubDeps({
      vpsLeases: { claim: () => lease, release: (held) => released.push(held) },
      vps: {
        vpsDriverError: () => null,
        vpsComputerAction: async () => {
          throw new Error("the VPS host refused the connection");
        },
        inspectVpsForAuto: async () => ({ ready: false }),
        vpsComputerMcp: () => ({ command: "", args: [], env: {} }),
        vpsComputerScreenshot: async () => ({ png: "", format: "png" }),
      },
    });
    await expect(
      resolveTurnComputerMounts({
        bot: { id: "bot-5", name: "Remote", computers: ["cloud"], cloudBackend: "vps" },
        cfg: EMPTY_CONFIG,
        engine: ACP_ENGINE,
        threadId: "thread-5",
        dispatchId: 1,
        allowed: null,
        deps,
      }),
    ).rejects.toThrow("refused the connection");
    expect(released).toEqual([lease]);
  });

  it("keeps the caught VPS error when an Auto lookup throws and nothing mounts", async () => {
    // The auto lookup's SSH/timeout error used to be replaced by the generic
    // "could not be reached" text in the no-mount branch.
    const deps = stubDeps({
      readHostConnection: () => null,
      vps: {
        vpsDriverError: () => null,
        vpsComputerAction: async () => ({ ready: false }),
        inspectVpsForAuto: async () => {
          throw new Error("ssh: connect to host vps-1 port 22: Operation timed out");
        },
        vpsComputerMcp: () => ({ command: "", args: [], env: {} }),
        vpsComputerScreenshot: async () => ({ png: "", format: "png" }),
      },
    });
    const run = resolveTurnComputerMounts({
      bot: { id: "bot-auto-vps", name: "Auto", cloudBackend: "vps" },
      cfg: EMPTY_CONFIG,
      engine: ACP_ENGINE,
      threadId: "thread-auto-vps",
      dispatchId: 1,
      allowed: null,
      deps,
    });
    await expect(run).rejects.toThrow("ssh: connect to host vps-1 port 22: Operation timed out");
  });

  describe("per-provider toggles are enforced on the cloud backend a bot resolves to", () => {
    // The legacy allowlist only says "cloud", which cannot tell ASCII.dev Box
    // from the Self-Hosted VPS.  Turning one of them off must still keep bots
    // off it at runtime, without taking the other one away.
    const providers = (over: Partial<Record<"asciiBox" | "selfHostedVps" | "localVm" | "localMac", boolean>>) =>
      ({
        botDefaults: {
          computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true, ...over },
        },
      }) as AppConfig;

    it("mounts nothing for an explicit VPS bot when the VPS provider is off", async () => {
      // stubDeps makes every VPS call throw, so reaching the VPS fails the test.
      const deps = stubDeps();
      const resolved = await resolveTurnComputerMounts({
        bot: { id: "bot-vps-off", name: "Remote", computers: ["cloud"], cloudBackend: "vps" },
        cfg: providers({ selfHostedVps: false }),
        engine: ACP_ENGINE,
        threadId: "thread-vps-off",
        dispatchId: 1,
        allowed: ["cloud", "vm", "local"],
        deps,
      });
      expect(resolved.mounts).toEqual([]);
    });

    it("mounts nothing for an explicit Box bot when the Box provider is off, instead of provisioning", async () => {
      const deps = stubDeps({
        box: {
          boxConfigured: () => true,
          findBox: async () => {
            throw new Error("the Box should not have been reached");
          },
          provisionBox: async () => {
            throw new Error("the Box should not have been provisioned");
          },
          readyBox: async () => null,
          screenshotBox: async () => ({ png: "", format: "png" }),
        },
      });
      const resolved = await resolveTurnComputerMounts({
        bot: { id: "bot-box-off", name: "Boxed", computers: ["cloud"], cloudBackend: "box" },
        cfg: providers({ asciiBox: false }),
        engine: ACP_ENGINE,
        threadId: "thread-box-off",
        dispatchId: 1,
        allowed: null,
        deps,
      });
      expect(resolved.mounts).toEqual([]);
    });

    it("still routes a VPS bot to the VPS when only the Box provider is off", async () => {
      const deps = stubDeps({
        vps: {
          vpsDriverError: () => null,
          vpsComputerAction: async () => {
            throw new Error("reached the VPS");
          },
          inspectVpsForAuto: async () => ({ ready: false }),
          vpsComputerMcp: () => ({ command: "", args: [], env: {} }),
          vpsComputerScreenshot: async () => ({ png: "", format: "png" }),
        },
      });
      await expect(
        resolveTurnComputerMounts({
          bot: { id: "bot-vps-on", name: "Remote", computers: ["cloud"], cloudBackend: "vps" },
          cfg: providers({ asciiBox: false }),
          engine: ACP_ENGINE,
          threadId: "thread-vps-on",
          dispatchId: 1,
          allowed: null,
          deps,
        }),
      ).rejects.toThrow("reached the VPS");
    });

    it("keeps an Auto bot's discovery off a disabled backend but leaves the host fallback", async () => {
      // inspectVpsForAuto throws in stubDeps: auto must not look at the VPS.
      const deps = stubDeps();
      const resolved = await resolveTurnComputerMounts({
        bot: { id: "bot-auto", name: "Auto", cloudBackend: "vps" },
        cfg: providers({ selfHostedVps: false }),
        engine: ACP_ENGINE,
        threadId: "thread-auto",
        dispatchId: 1,
        allowed: null,
        deps,
      });
      expect(resolved.mounts.map((m) => m.kind)).toEqual(["local"]);
    });
  });

  it("stops when a newer dispatch has taken the thread", async () => {
    const deps = stubDeps({ checkpoint: async () => false, acquireLocalVm: async () => HOST_STDIO });
    const resolved = await resolveTurnComputerMounts({
      bot: { id: "bot-4", name: "Stale", computers: ["vm"] },
      cfg: EMPTY_CONFIG,
      engine: ACP_ENGINE,
      threadId: "thread-4",
      dispatchId: 1,
      allowed: null,
      deps,
    });
    expect(resolved.cancelled).toBe(true);
    expect(resolved.mounts).toEqual([]);
  });
});

/* ── the wiring, on the real harness ──────────────────────────────────── */

function imageInspectJson(): string {
  return JSON.stringify([
    {
      Id: IMAGE_ID,
      Config: {
        Labels: {
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
        },
      },
    },
  ]);
}

/** __NAME__ is substituted by the fake docker from the inspect argv, because
 * the container name derives from a bot id that only exists at runtime. */
function containerInspectTemplate(): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      Image: IMAGE_ID,
      Config: {
        Image: VPS_IMAGE,
        Env: ["VNC_PW=fake-viewer-value"],
        Labels: {
          [VPS_MANAGED_LABEL]: "1",
          [VPS_CONTAINER_LABEL]: "__NAME__",
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          [VPS_VIEWER_LABEL]: "1",
        },
      },
      State: { Running: true },
      NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.5" } } },
      Mounts: [],
      HostConfig: {
        Binds: [],
        VolumesFrom: [],
        NetworkMode: "bridge",
        PortBindings: {},
        PublishAllPorts: false,
        Memory: VPS_DEFAULT_MEMORY_GIB * 1024 * 1024 * 1024,
        MemorySwap: VPS_DEFAULT_MEMORY_GIB * 1024 * 1024 * 1024,
        NanoCpus: VPS_DEFAULT_CPUS * 1_000_000_000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        PidMode: "",
        IpcMode: "private",
        UTSMode: "",
        ShmSize: 512 * 1024 * 1024,
        Devices: [],
        DeviceRequests: [],
        SecurityOpt: [],
        UsernsMode: "",
        CgroupnsMode: "private",
        OomKillDisable: false,
        AutoRemove: false,
        RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      },
    },
  ]);
}

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *" image inspect "*) cat "$FAKE_DOCKER_DIR/image.json" ;;
  *" exec "*"--version"*) echo "cua-driver ${CUA_DRIVER_VERSION}" ;;
  *" exec "*"--screenshot-out-file"*) echo "{}" ;;
  *" exec "*"health_report"*) echo '{"schema_version":"1","overall":"ok","checks":[]}' ;;
  *" exec "*"get_desktop_state"*) echo "{}" ;;
  *" exec "*"base64"*) cat "$FAKE_DOCKER_DIR/screenshot.b64" ;;
  *" exec "*"status"*) echo "running" ;;
  *" exec "*"rm -f"*) : ;;
  *" inspect "*) for arg in "$@"; do name="$arg"; done; sed "s|__NAME__|$name|g" "$FAKE_DOCKER_DIR/container.json.tpl" ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 64 ;;
esac
`;

interface McpEntry {
  name: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }> | Record<string, string>;
}

interface WireMessage {
  id: string;
  role?: string;
  kind?: string;
  text?: string;
  card?: { requestId?: string; answered?: string; title?: string };
  tool?: { name?: string; ok?: boolean };
  from?: { botId?: string };
}

posixOnly("room turns carry the same computers as a direct chat", () => {
  let child: ChildProcess;
  let home: string;
  let base: string;
  let stderr = "";
  let mountsDump: string;
  let desklessDump: string;
  // Every argv the fake docker was handed, which is the only record a test
  // has that the VPS resolver actually ran for a given bot.
  let dockerLog: string;

  const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const until = async <T,>(probe: () => Promise<T | null>, what: string, timeoutMs = 40_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = await probe();
      if (hit !== null && hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`${what} never happened. stderr: ${stderr.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  };

  const botById = async (id: string) =>
    (await api("GET", "/api/bots")).body.bots.find((b: { id: string }) => b.id === id);

  // SAFETY: the harness's own messages route, whose wire shape is the one
  // `WireMessage` describes; a missing array is defaulted before the cast.
  const messages = async (threadId: string): Promise<WireMessage[]> =>
    ((await api("GET", `/api/threads/${threadId}/messages`)).body.messages ?? []) as WireMessage[];

  const makeBot = async (name: string, instanceId: string, patch: Record<string, unknown> = {}) => {
    const created = await api("POST", "/api/bots");
    expect(created.status).toBe(201);
    const patched = await api("PATCH", `/api/bots/${created.body.bot.id}`, {
      name,
      ...patch,
      modelSelection: { instanceId, model: "fake-model" },
    });
    expect(patched.status).toBe(200);
    return patched.body.bot ?? created.body.bot;
  };

  const makeRoom = async (name: string, memberId: string) => {
    const created = await api("POST", "/api/groups", {
      name,
      memberIds: [memberId],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: memberId } },
    });
    expect(created.status).toBe(201);
    return created.body.group;
  };

  /** The `mcpServers` array the fake CLI was handed at `session/new`, for the
   * most recent session on this dump. */
  // SAFETY: the fake ACP CLI wrote this file itself from the `mcpServers`
  // array of `session/new`; the shape is pinned by fake-acp-cli.ts.
  const mountedServers = (dump: string): McpEntry[] =>
    JSON.parse(readFileSync(`${dump}.mcp.json`, "utf8")) as McpEntry[];

  /** The echoed reply carries the WHOLE prompt the turn was sent. */
  const echoedPrompt = (threadId: string, botId: string): Promise<string> =>
    until(async () => {
      const bot = await botById(botId);
      if (bot?.busy) return null;
      const text = (await messages(threadId)).find(
        (m) => m.kind === "text" && m.role === "bot" && m.text?.startsWith("echo: "),
      )?.text;
      return text ?? null;
    }, `the echoed turn on ${threadId}`);

  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "omb-rooms-cli-lane-"));
    mkdirSync(join(home, ".botfleet"), { recursive: true });
    const fakeBin = join(home, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    mountsDump = join(home, "mounts.dump.json");
    desklessDump = join(home, "deskless.dump.json");
    dockerLog = join(fakeBin, "docker.log");

    writeFileSync(join(fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });
    chmodSync(join(fakeBin, "docker"), 0o755);
    writeFileSync(join(fakeBin, "image.json"), imageInspectJson());
    writeFileSync(join(fakeBin, "container.json.tpl"), containerInspectTemplate());
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(600),
      Buffer.from("IEND", "ascii"),
    ]);
    writeFileSync(join(fakeBin, "screenshot.b64"), png.toString("base64"));
    writeFileSync(dockerLog, "");

    writeFileSync(
      join(home, ".botfleet", "config.json"),
      JSON.stringify({
        vps: { sshAlias: "production-vps" },
        instances: {
          // One instance per bot: the fake CLI writes its mcpServers dump to
          // a path taken from its environment, so two bots sharing one
          // instance would overwrite each other's evidence.
          mounts: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_DUMP: mountsDump },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          deskless: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "echo-gated", FAKE_ACP_DUMP: desklessDump },
            config: { cli: FAKE_CLI, fullAuto: true },
          },
          asker: {
            driver: "grokAgent",
            environment: { FAKE_ACP_MODE: "permission" },
            config: { cli: FAKE_CLI, fullAuto: false },
          },
          // The one engine on this lane whose `sendTurn` can be made to
          // REJECT rather than settle.  Antigravity creates its own
          // per-thread workspace under the data dir before it emits a single
          // event, and rethrows if that fails; every other CLI failure —
          // a missing binary, a failed spawn, an unauthenticated CLI — runs
          // through the ACP core's `finishBeforeDispatch`, which emits
          // `turn.completed` and therefore never reaches the code this
          // suite's rejection test is about.  The `agy` CLI is never
          // spawned, so none has to exist.
          gravity: { driver: "antigravityAgent" },
        },
      }),
      { mode: 0o600 },
    );

    // A probed free port rather than a random one: three suites in this
    // checkout boot real harnesses, and a lost bind surfaces as "the server
    // never came up" rather than as "port taken".
    const port = await freePortBlock([0]);
    base = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_EXTRA_PATH: fakeBin,
      FAKE_DOCKER_DIR: fakeBin,
      FAKE_DOCKER_LOG: dockerLog,
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", (c) => (stderr += c));

    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if (await harnessReady(base)) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 60_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it(
    "mounts the same computer for a room member as for the same bot 1:1, and releases its turn lease",
    async () => {
      const bot = await makeBot("Hands", "mounts", { cloudBackend: "vps" });
      // `computers` stays unset — Auto, which attaches to the existing
      // container and never provisions.  The point of the test is that the
      // bot changed nothing between the two conversations.

      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: "check the desktop" })).status).toBe(202);
      const directPrompt = await echoedPrompt(bot.threadId, bot.id);
      const direct = mountedServers(mountsDump).find((s) => s.name === "computer");
      expect(direct, "the 1:1 turn mounted no computer, so there is nothing to compare").toBeTruthy();

      const room = await makeRoom("Ops", bot.id);
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "check the desktop" })).status).toBe(202);
      const roomPrompt = await echoedPrompt(room.threadId, bot.id);
      const inRoom = mountedServers(mountsDump).find((s) => s.name === "computer");

      // THE assertion: the same bot, the same grant, the same mount.
      expect(inRoom, "the room member lost its computer").toBeTruthy();
      expect(inRoom).toEqual(direct);
      expect((inRoom?.args ?? []).some((a) => a.includes("vps-container-mcp"))).toBe(true);
      expect(inRoom?.args ?? []).toContain(CONTAINER_ID);

      // and it was told, in the same words, that it has one
      expect(directPrompt).toContain("self-hosted remote Linux computer");
      expect(roomPrompt).toContain("self-hosted remote Linux computer");

      // The room's VPS turn lease is released on turn.completed like the 1:1
      // lane's — a backend change is refused (409) only while one is held, so
      // a 200 here is the release.
      expect((await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "box" })).status).toBe(200);
    },
    120_000,
  );

  it(
    "hands a room member's VPS turn lease back when its dispatch is rejected",
    async () => {
      // The release the test above proves rides on `turn.completed`, and a
      // REJECTED dispatch never produces one: the thread-keyed subscriber
      // that normally gives the lease back is simply never called.  The
      // lease then sits in `activeVpsThreads` for the life of the harness,
      // and the bot answers 409 to a backend change — and to VPS sleep and
      // remove — for a turn that never ran at all.  So the dispatcher has to
      // unwind it itself, on the one exit where nothing else will.
      //
      // Cloud is asked for by name rather than left on Auto, because an
      // explicit destination that cannot be had REFUSES the turn from inside
      // the resolver — and the resolver gives its own lease back on that
      // path.  So a turn that gets as far as the driver is a turn whose VPS
      // resolved, which is exactly the turn that is still holding a lease
      // when the driver throws.
      const bot = await makeBot("Grounded", "gravity", { cloudBackend: "vps", computers: ["cloud"] });
      const room = await makeRoom("Rejected", bot.id);

      // Antigravity mkdirs `<data dir>/workspaces/<thread>` for its turn and
      // rethrows if it cannot, before it has emitted anything — so an
      // ordinary file sitting on that exact path is a dispatch that rejects
      // rather than one that fails and settles.  The tag is the driver's own
      // sanitisation of the thread id, which is why it is spelled the same
      // way here.
      const blocked = join(home, ".botfleet", "workspaces", room.threadId.replace(/[^\w-]/g, ""));
      mkdirSync(dirname(blocked), { recursive: true });
      writeFileSync(blocked, "");

      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "check the desktop" })).status).toBe(202);

      // The rejection itself, in the room's own transcript.  Matching on the
      // failed mkdir is what distinguishes it from a turn that completed
      // badly: that message only ever reaches a message row through the
      // dispatcher's `.catch`, because the driver threw it instead of
      // emitting it.
      const failure = await until(async () => {
        const row = (await messages(room.threadId)).find(
          (m) => m.kind === "activity" && m.tool?.name?.includes("mkdir"),
        );
        return row ?? null;
      }, "the rejected dispatch");
      expect(failure.tool?.ok).toBe(false);
      expect(await until(async () => ((await botById(bot.id))?.busy === false ? true : null), "the freed bot")).toBe(
        true,
      );

      // There was a lease to lose.  The claim happens inside the resolver,
      // immediately before it inspects the bot's own container, so the fake
      // docker having been asked about THIS bot's container is the evidence
      // that this turn really held one.
      expect(readFileSync(dockerLog, "utf8")).toContain(vpsContainerName(bot.id));

      // and it was handed back.  A backend change is refused with 409 while
      // the bot is busy OR while a VPS turn lease is held, and the bot went
      // idle above — so at this point only a stranded lease could refuse it,
      // and a 200 is the release.
      expect((await api("PATCH", `/api/bots/${bot.id}`, { cloudBackend: "box" })).status).toBe(200);
    },
    120_000,
  );

  it(
    "mounts nothing for a room member whose computer is switched off",
    async () => {
      const bot = await makeBot("Deskless", "deskless", { cloudBackend: "vps", computers: [] });
      const room = await makeRoom("Quiet", bot.id);
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "say hello" })).status).toBe(202);
      const prompt = await echoedPrompt(room.threadId, bot.id);

      expect(mountedServers(desklessDump).some((s) => s.name.startsWith("computer"))).toBe(false);
      expect(prompt).not.toContain("self-hosted remote Linux computer");
    },
    120_000,
  );

  it(
    "carries a room member's approval ask to the room thread and delivers the answer",
    async () => {
      const bot = await makeBot("Asker", "asker", { computers: [] });
      const room = await makeRoom("Approvals", bot.id);
      expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "run it" })).status).toBe(202);

      // The card lands on the ROOM thread, attributed to the member that
      // asked — the fold resolves a room by thread and stamps the speaker.
      const card = await until(async () => {
        const pending = (await messages(room.threadId)).find((m) => m.kind === "options" && m.card?.requestId);
        return pending ?? null;
      }, "the room approval card");
      expect(card.from?.botId).toBe(bot.id);
      expect(card.card?.title).toBe("Approval needed");

      // Answering BY THREAD reaches the engine that asked: the broker does
      // not own a CLI requestId, so `deliverDecision` falls through to the
      // adapter, and the turn it was blocking finishes.
      const answered = await api("POST", `/api/threads/${room.threadId}/respond`, {
        requestId: card.card!.requestId,
        behavior: "allow",
      });
      expect(answered.status).toBe(200);
      expect(answered.body.outcome).not.toBe("unavailable");

      expect(
        await until(async () => ((await botById(bot.id))?.busy === false ? true : null), "the answered turn"),
      ).toBe(true);
    },
    120_000,
  );
});

// BYO Linux VPS computer. The agent process stays local; Docker's own SSH
// transport reaches the user's daemon and the official CUA MCP server stays
// inside one managed container per bot.
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";

import {
  BASE_IMAGE,
  CUA_DRIVER_VERSION,
  CUA_SOCKET,
  DISPLAY,
  IMAGE as CUA_IMAGE,
  cuaExecArgs,
  dockerSecurityIsHardened,
  healCuaShimsExecArgs,
  redactSecrets,
  shouldHealCuaShims,
  imageLabelsMatch,
  managedImageDockerfile,
  wholeScreenshot,
  type DockerHardeningConfig,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  DRIVER_LABEL,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
} from "./container-computer.ts";
import {
  ensureSharedVpsSessionExecArgs,
  isSharedVpsMode,
  perBotOccupancyKey,
  vpsDriverDisplay,
  vpsDriverSocket,
  vpsOccupancyKey,
  vpsScreenshotPath,
  vpsSharedBotSession,
} from "./vps-shared-session.ts";
import type { ComputerReach } from "./computer-capability.ts";
import {
  VPS_DEFAULT_CPUS,
  VPS_DEFAULT_MEMORY_GIB,
  isValidSshAlias,
  vpsCpus,
  vpsMemoryGib,
  vpsSshAlias,
  type AppConfig,
} from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import {
  credentialPermissionHardeningShell,
  packageCredentialArchive,
  prepareCredentialSyncWorkspace,
  type CredentialSyncResult,
} from "./vm-cli-credentials.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

/** The per-desktop budget for one managed VPS container.  The run arguments
 * and the inspect matcher are both derived from this one value, so a desktop
 * created with one budget can never be graded against another. */
export interface VpsDesktopSize {
  memoryGib: number;
  cpus: number;
}

export function vpsDesktopSize(cfg: AppConfig): VpsDesktopSize {
  return { memoryGib: vpsMemoryGib(cfg), cpus: vpsCpus(cfg) };
}

const GIB = 1024 * 1024 * 1024;

export const VPS_IMAGE = CUA_IMAGE;
export const VPS_MANAGED_LABEL = "com.botfleet.vps";
export const VPS_CONTAINER_LABEL = "com.botfleet.container";
export const VPS_VIEWER_LABEL = "com.botfleet.vps-viewer";
const LEGACY_VPS_MANAGED_LABELS = ["com.openmausbot.vps", "com.opengrokbot.vps"] as const;
const LEGACY_VPS_CONTAINER_LABELS = ["com.openmausbot.container", "com.opengrokbot.container"] as const;
export const VPS_CONTAINER_PREFIX = "botfleet-vps";

// ── Shared / per-bot targeting ────────────────────────────────────────────
// Mirrors LocalVmTarget in container-computer.ts.

export interface VpsTarget {
  /** Stable, non-secret identity used for leases, caches, and tunnel maps. */
  key: string;
  containerName: string;
  label: string;
}

export const SHARED_VPS_TARGET: VpsTarget = {
  key: "shared",
  containerName: `${VPS_CONTAINER_PREFIX}-shared`,
  label: "shared",
};

/** Per-bot target: container name matches the existing vpsContainerName(). */
export function perBotVpsTarget(botId: string): VpsTarget {
  const hash = createHash("sha256").update(botId).digest("hex");
  return {
    key: `bot:${hash}`,
    containerName: vpsContainerName(botId),
    label: hash,
  };
}

/** Resolve the VPS target for a bot based on the workspace's vpsMode. */
export function vpsTargetFor(cfg: AppConfig, botId: string): VpsTarget {
  if (cfg.botDefaults?.vpsMode === "shared") return SHARED_VPS_TARGET;
  return perBotVpsTarget(botId);
}

/** Every VPS target a workspace could have created, deduped by key.
 *  Used by mode-switch cleanup to find containers from both modes. */
export function vpsModeSwitchTargets(botIds: readonly string[]): VpsTarget[] {
  const all: VpsTarget[] = [SHARED_VPS_TARGET, ...botIds.map((id) => perBotVpsTarget(id))];
  return all.filter((target, i) => all.findIndex((o) => o.key === target.key) === i);
}

/** Remove a specific VPS target's container if it exists.  Addressed by
 *  target, not by botId routing, so mode-switch cleanup can tear down
 *  both shared and per-bot containers regardless of the current mode. */
export async function vpsRemoveTargetIfPresent(
  cfg: AppConfig,
  target: VpsTarget,
  runner: VpsCommandRunner = defaultRunner,
): Promise<void> {
  const alias = vpsSshAlias(cfg);
  if (!alias) return;
  const run = (args: string[], timeoutMs = 30_000) =>
    runner(vpsDockerArgs(alias, args), { timeoutMs });
  try {
    const stdout = (await run(["inspect", target.containerName])).stdout;
    const inspected = JSON.parse(stdout) as Array<{
      Config?: { Labels?: Record<string, string> };
      State?: { Running?: boolean };
    }>;
    const labels = inspected[0]?.Config?.Labels;
    const managed =
      labels?.[VPS_MANAGED_LABEL] === "1" ||
      LEGACY_VPS_MANAGED_LABELS.some((key) => labels?.[key] === "1");
    if (!managed) return;
    await run(["rm", "-f", target.containerName], 2 * 60_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingObjectMessage(message)) return;
    // Swallow transport errors during best-effort cleanup.
  }
}
export const LEGACY_VPS_CONTAINER_PREFIXES = ["openmausbot-vps", "opengrokbot-vps"] as const;
// SIGTERM must give ssh + docker time to tear down the remote exec before the
// SIGKILL escalation; 1s was routinely too short over a WAN round-trip, and an
// orphaned remote exec keeps the driver socket busy for the next command.
const COMMAND_TIMEOUT_KILL_GRACE_MS = 5_000;

const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/i;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/i;
const PIDS_LIMIT = 512;
const INTERNAL_VIEWER_PORT = 6901;
const VIEWER_VERSION = "1";
const lifecycleLocks = new Map<string, Promise<void>>();
/** Per-bot shared-session setup (Xvfb + CUA serve) — not the container lock. */
const botSessionLocks = new Map<string, Promise<void>>();
/** Concurrent shared-mode provisions of the one container coalesce into a
 * single flight.  Provision is the idempotent turn-start path: when N bots
 * start turns together, serialising N inspections behind a 5 s acquire timeout
 * made the later bots fail with a spurious "VPS is being prepared" 409. */
const provisionFlights = new Map<string, Promise<VpsComputerStatus>>();
/** Automatic CLI credential sync is rate-limited: it runs at most once per
 * container id per TTL, concurrent callers share one in-flight sync, and a
 * failure backs off briefly rather than retrying on every bot turn.  The
 * manual Sync button calls vpsSyncCliCredentials directly and is never gated. */
const CLI_SYNC_TTL_MS = 10 * 60_000;
const CLI_SYNC_FAILURE_BACKOFF_MS = 60_000;
const cliSyncState = new Map<string, { containerId: string; until: number }>();
const cliSyncFlights = new Map<string, Promise<void>>();

export function resetVpsCliSyncThrottle(): void {
  cliSyncState.clear();
  cliSyncFlights.clear();
  provisionFlights.clear();
}

async function autoSyncCliCredentials(
  cfg: AppConfig,
  target: VpsTarget,
  containerId: string,
  runner: VpsCommandRunner,
): Promise<void> {
  const key = `${vpsSshAlias(cfg) ?? ""}:${target.containerName}`;
  const known = cliSyncState.get(key);
  if (known && known.containerId === containerId && Date.now() < known.until) return;
  const flight = cliSyncFlights.get(key);
  if (flight) return flight;
  const started = vpsSyncCliCredentials(cfg, target, runner).then(
    () => {
      cliSyncState.set(key, { containerId, until: Date.now() + CLI_SYNC_TTL_MS });
    },
    (err) => {
      cliSyncState.set(key, { containerId, until: Date.now() + CLI_SYNC_FAILURE_BACKOFF_MS });
      console.warn(`[vps] automatic CLI credentials sync failed: ${err instanceof Error ? err.message : String(err)}`);
    },
  ).finally(() => {
    cliSyncFlights.delete(key);
  });
  cliSyncFlights.set(key, started);
  return started;
}
// A held lock means a lifecycle mutation (worst case: a 10-minute image
// build) is running. Waiting it out would wedge Sleep and the screenshot
// poll behind it, so acquisition fails fast instead.
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
// The panel polls status every 4-6s and the screen poller re-checks it before
// every frame; each full status is several docker-over-SSH processes. Same
// pattern as container-computer's screenshotStatusCache, and the same TTL.
const STATUS_CACHE_TTL_MS = 10_000;
const statusCache = new Map<string, { status: VpsComputerStatus; expiresAt: number }>();
const viewerConnections = new Map<string, { privateIp: string; password: string }>();
const desktopTunnels = new Map<
  string,
  { child: ReturnType<typeof spawn>; joinUrl: string; expiry: ReturnType<typeof setTimeout> }
>();

export interface VpsCommandOptions {
  input?: string | Buffer;
  timeoutMs?: number;
}

export type VpsCommandRunner = (
  args: string[],
  options?: VpsCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

export type VpsLifecycleAction = "provision" | "start" | "stop" | "remove";

export interface VpsComputerStatus {
  configured: boolean;
  sshAlias: string | null;
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "private" | "unsafe" | "unknown";
  mounts: "none" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  desktopReady: boolean;
  desktop_error: string | null;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  container_id: string | null;
  image_id: string | null;
}

function containerNamePart(botId: string): string {
  return botId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "bot";
}

/** Stable across restarts and independent of the bot's editable display name. */
export function vpsContainerName(botId: string): string {
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  return `${VPS_CONTAINER_PREFIX}-${containerNamePart(botId)}-${hash}`;
}

/** Current per-bot name first, then predecessors from the OpenMausBot / OpenGrokBot rename. */
export function vpsContainerNameCandidates(botId: string): string[] {
  const part = containerNamePart(botId);
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 12);
  const legacy = [VPS_CONTAINER_PREFIX, ...LEGACY_VPS_CONTAINER_PREFIXES].map((prefix) => `${prefix}-${part}-${hash}`);
  return [vpsContainerName(botId), ...legacy];
}

/** Container name candidates appropriate to the target's mode.  For the
 *  shared target, only its deterministic name is searched (no legacy
 *  per-bot names); for a per-bot target, the full legacy set is tried. */
function containerNameCandidatesForTarget(target: VpsTarget, botId: string): string[] {
  if (target.key === SHARED_VPS_TARGET.key) return [SHARED_VPS_TARGET.containerName];
  return vpsContainerNameCandidates(botId);
}

export function vpsDockerArgs(alias: string, args: string[]): string[] {
  if (!isValidSshAlias(alias)) {
    throw new Error("invalid VPS SSH config alias");
  }
  return ["-H", `ssh://${alias}`, ...args];
}

/** A live VPS desktop is never published by Docker. SSH binds one temporary
 * loopback port on this computer and forwards it to noVNC on the container's
 * private bridge address. Every caller-controlled component is validated
 * before it becomes an argv value. */
export function vpsSshTunnelArgs(alias: string, localPort: number, privateIp: string): string[] {
  if (!isValidSshAlias(alias)) throw new Error("invalid VPS SSH config alias");
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
    throw new Error("invalid VPS viewer port");
  }
  if (!privateDockerIpv4(privateIp)) throw new Error("invalid VPS private container address");
  return [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ControlMaster=no",
    "-L",
    `127.0.0.1:${localPort}:${privateIp}:${INTERNAL_VIEWER_PORT}`,
    alias,
  ];
}

function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      // SAFETY: this server was bound to an IPv4 TCP address above, so Node
      // returns AddressInfo here rather than a Unix-socket string.
      const port = (probe.address() as AddressInfo).port;
      probe.close((error) => {
        if (error) reject(error);
        else if (port >= 1024) resolve(port);
        else reject(new Error("could not reserve a VPS viewer port"));
      });
    });
  });
}

function loopbackAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

function stopDesktopTunnel(key: string): boolean {
  const tunnel = desktopTunnels.get(key);
  if (!tunnel) return false;
  desktopTunnels.delete(key);
  clearTimeout(tunnel.expiry);
  if (tunnel.child.exitCode === null && !tunnel.child.killed) tunnel.child.kill("SIGTERM");
  return true;
}

/** Close the VPS desktop tunnel for a bot.  Requires cfg to resolve
 *  the target in shared vs per-bot mode. */
export function closeVpsDesktopTunnel(cfg: AppConfig, botId: string) {
  return { closed: stopDesktopTunnel(vpsOccupancyKey(cfg, botId)) };
}

/** Close a VPS desktop tunnel by target key directly — used by
 *  mode-switch cleanup and close-all, which address targets, not bots. */
export function closeVpsDesktopTunnelForTarget(key: string) {
  return { closed: stopDesktopTunnel(key) };
}

export function closeAllVpsDesktopTunnels(): void {
  for (const key of desktopTunnels.keys()) stopDesktopTunnel(key);
}

const STREAM_CAP_CHARS = 16 * 1024 * 1024;

/** Keeps the LAST 16MB of a stream without rebuilding one giant string per
 * chunk (a 10-minute `docker build` stream made that rebuild quadratic).
 * Chunks fall off the front as soon as the tail alone covers the cap; the
 * final slice preserves the exact cap semantics of the old accumulator. */
function tailCollector() {
  const chunks: string[] = [];
  let total = 0;
  return {
    push(chunk: string) {
      chunks.push(chunk);
      total += chunk.length;
      for (;;) {
        const first = chunks[0];
        if (chunks.length < 2 || first === undefined || total - first.length < STREAM_CAP_CHARS) break;
        chunks.shift();
        total -= first.length;
      }
    },
    text(): string {
      return chunks.join("").slice(-STREAM_CAP_CHARS);
    },
  };
}

export function defaultRunner(args: string[], options: VpsCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      shell: false,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = tailCollector();
    const stderr = tailCollector();
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      finish();
    };
    timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        settle(() => reject(new Error("Docker-over-SSH command timed out")));
      }, COMMAND_TIMEOUT_KILL_GRACE_MS);
      killTimer.unref?.();
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 120_000);
    timeout.unref?.();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr.push(chunk);
    });
    child.stdin.on("error", (error) => {
      if (timedOut) return;
      settle(() => reject(new Error(`Docker-over-SSH stdin failed: ${error.message}`)));
    });
    child.on("error", (error) => {
      settle(() => reject(new Error(`Docker-over-SSH could not start: ${error.message}`)));
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        settle(() => reject(new Error("Docker-over-SSH command timed out")));
        return;
      }
      settle(() => {
        if (code === 0) return resolve({ stdout: stdout.text(), stderr: stderr.text() });
        const detail = redactSecrets(stderr.text().trim().slice(-1000));
        reject(new Error(detail || `Docker-over-SSH exited ${code ?? signal ?? "without a status"}`));
      });
    });
    try {
      child.stdin.end(options.input);
    } catch (error) {
      settle(() => reject(new Error(`Docker-over-SSH stdin failed: ${error instanceof Error ? error.message : String(error)}`)));
    }
  });
}

function emptyStatus(target: VpsTarget, alias: string | null): VpsComputerStatus {
  return {
    configured: Boolean(alias),
    sshAlias: alias,
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    mounts: "unknown",
    security: "unknown",
    desktopReady: false,
    desktop_error: null,
    ready: false,
    problem: alias ? "Docker over SSH is not reachable" : "Configure a VPS SSH alias in App Settings → Connections",
    image_ref: VPS_IMAGE,
    base_image_ref: BASE_IMAGE,
    driver_version: CUA_DRIVER_VERSION,
    container_name: target.containerName,
    container_id: null,
    image_id: null,
  };
}

/** Docker and Podman both phrase a clean not-found this way ("No such
 * object" / "No such image" / "no such container"); anything else out of an
 * inspect is a transport or daemon failure and must NOT be read as absence —
 * a flaky WAN link that looked like "missing" used to send provision into
 * `docker run --name <existing>` and a baffling name-in-use error. */
function isMissingObjectMessage(message: string): boolean {
  return /no such (object|image|container)/i.test(message);
}

function transportFailure(message: string): string {
  return `Docker over SSH failed while checking the VPS: ${message.trim().slice(0, 200) || "unknown transport error"}`;
}

function privateDockerIpv4(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function viewerPassword(env: string[] | undefined): string | null {
  const value = env?.find((entry) => entry.startsWith("VNC_PW="))?.slice("VNC_PW=".length);
  return value && /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value : null;
}

function hasNoHostMounts(detail: {
  Mounts?: unknown;
  HostConfig?: { Binds?: string[] | null; VolumesFrom?: string[] | null };
}): boolean {
  return (
    Array.isArray(detail.Mounts) &&
    detail.Mounts.length === 0 &&
    (!detail.HostConfig?.Binds || detail.HostConfig.Binds.length === 0) &&
    (!detail.HostConfig?.VolumesFrom || detail.HostConfig.VolumesFrom.length === 0)
  );
}

function hasNoPublishedPorts(config: {
  NetworkMode?: string;
  PortBindings?: Record<string, unknown> | null;
  PublishAllPorts?: boolean;
} | undefined, networks?: Record<string, unknown> | null): boolean {
  if (!config) return false;
  const networkMode = (config.NetworkMode ?? "").toLowerCase();
  if (!["default", "bridge"].includes(networkMode)) return false;
  const attached = Object.keys(networks ?? {}).map((name) => name.toLowerCase());
  if (attached.length !== 1 || !["default", "bridge"].includes(attached[0]!)) return false;
  return (
    config.PublishAllPorts !== true &&
    !Object.values(config.PortBindings ?? {}).some((value) => Array.isArray(value) && value.length > 0)
  );
}

function statusProblem(status: VpsComputerStatus): string | null {
  if (!status.configured) return "Configure a VPS SSH alias in App Settings → Connections";
  if (!status.daemonUp) return "Docker over SSH could not reach the VPS; check the SSH alias and Docker on the VPS";
  if (!status.image) return `Prepare the pinned BotFleet CUA image on the VPS (Driver ${CUA_DRIVER_VERSION})`;
  if (status.container === "missing") return "No BotFleet container exists for this bot on the VPS";
  if (!status.imageMatches) return "The VPS container uses an incompatible or untrusted BotFleet image";
  if (!status.managed) return "The VPS container name is occupied by a container BotFleet did not create";
  if (status.network === "unsafe") return "The VPS container uses an unapproved network or publishes ports; refusing to use it";
  if (status.mounts === "unsafe") return "The VPS container has host mounts; refusing to use it";
  if (status.security === "unsafe") return "The VPS container is missing BotFleet safety limits";
  if (status.container === "stopped") return "The BotFleet VPS container is stopped";
  if (status.desktop_error) return `The VPS CUA desktop failed to start: ${status.desktop_error}`;
  if (!status.desktopReady) return "The VPS container started, but CUA Driver is not ready yet";
  return null;
}

/** The uncached inspection. Lifecycle mutations and their readiness waits
 * call this directly — they must see and publish the truth, never a poll's
 * snapshot; the exported vpsComputerStatus wraps it with the poll cache.
 *
 * `docker info` is deliberately NOT probed as its own round-trip: every
 * docker-over-SSH invocation is a full process + SSH connection, and the
 * image inspect right below already proves the daemon answers — even its
 * "No such image" failure is a daemon reply. Anything that is neither JSON
 * nor a "no such object" reply is attributed to the transport instead. */
function vpsBotSessionLockKey(cfg: AppConfig, botId: string): string | null {
  const alias = vpsSshAlias(cfg);
  if (!alias || !isSharedVpsMode(cfg)) return null;
  return `${alias}:session:${perBotOccupancyKey(botId)}`;
}

async function ensureSharedVpsBotSession(
  cfg: AppConfig,
  botId: string,
  containerRef: string,
  runner: VpsCommandRunner,
): Promise<void> {
  if (!isSharedVpsMode(cfg)) return;
  const alias = vpsSshAlias(cfg);
  if (!alias) return;
  const session = vpsSharedBotSession(botId);
  const sessionKey = vpsBotSessionLockKey(cfg, botId);
  const runEnsure = async () => {
    // Best effort and throttled: containers built before the image gained the
    // PATH symlinks are repaired in place rather than replaced under the bots.
    if (shouldHealCuaShims(`${alias}:${containerRef}`)) {
      await runner(vpsDockerArgs(alias, healCuaShimsExecArgs(containerRef)), { timeoutMs: 20_000 }).catch(
        () => undefined,
      );
    }
    await runner(vpsDockerArgs(alias, ensureSharedVpsSessionExecArgs(containerRef, session)), {
      timeoutMs: 90_000,
    });
  };
  if (sessionKey) return withVpsLock(botSessionLocks, sessionKey, runEnsure);
  return runEnsure();
}

async function computeVpsComputerStatus(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner,
): Promise<VpsComputerStatus> {
  const alias = vpsSshAlias(cfg);
  const target = vpsTargetFor(cfg, botId);
  const status = emptyStatus(target, alias);
  if (!alias) return status;
  viewerConnections.delete(`${alias}:${status.container_name}`);
  const run = (args: string[], timeoutMs = 30_000, input?: string) =>
    runner(vpsDockerArgs(alias, args), { timeoutMs, input });

  let inspectedImageId: string | null = null;
  try {
    const inspected = JSON.parse((await run(["image", "inspect", VPS_IMAGE])).stdout) as Array<{
      Id?: string;
      id?: string;
      Config?: { Labels?: Record<string, string> };
      config?: { Labels?: Record<string, string>; labels?: Record<string, string> };
    }>;
    status.daemonUp = true;
    const image = inspected[0];
    const labels = image?.Config?.Labels ?? image?.config?.Labels ?? image?.config?.labels;
    const imageId = image?.Id ?? image?.id;
    inspectedImageId = imageId && IMAGE_ID.test(imageId) ? imageId : null;
    status.image_id = inspectedImageId;
    status.image = Boolean(inspectedImageId) && imageLabelsMatch(labels);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isMissingObjectMessage(message)) {
      status.problem = transportFailure(message);
      return status;
    }
    // A clean "no such image" is still a daemon answer.
    status.daemonUp = true;
    status.image = false;
  }
  try {
    type InspectedContainer = {
      Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
      HostConfig?: DockerHardeningConfig & {
        Binds?: string[] | null;
        VolumesFrom?: string[] | null;
        NetworkMode?: string;
        PortBindings?: Record<string, unknown> | null;
        PublishAllPorts?: boolean;
      };
      Id?: string;
      id?: string;
      Image?: string;
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> | null };
      Mounts?: unknown;
      State?: { Running?: boolean };
    };
    let inspected: InspectedContainer[] | null = null;
    let lastMissing: unknown;
    for (const name of containerNameCandidatesForTarget(target, botId)) {
      try {
        inspected = JSON.parse((await run(["inspect", name])).stdout) as InspectedContainer[];
        status.container_name = name;
        lastMissing = undefined;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isMissingObjectMessage(message)) throw error;
        lastMissing = error;
      }
    }
    if (!inspected) throw lastMissing ?? new Error("no such container");
    const detail = inspected[0];
    const labels = detail?.Config?.Labels;
    const containerId = detail?.Id ?? detail?.id;
    status.container_id = containerId && CONTAINER_ID.test(containerId) ? containerId : null;
    status.container = detail?.State?.Running ? "running" : "stopped";
    status.imageMatches =
      status.image &&
      Boolean(status.container_id) &&
      (detail?.Config?.Image === VPS_IMAGE || detail?.Config?.Image === inspectedImageId) &&
      Boolean(inspectedImageId) &&
      detail?.Image === inspectedImageId &&
      imageLabelsMatch(labels) &&
      labels?.[VPS_VIEWER_LABEL] === VIEWER_VERSION;
    const managedFlag =
      labels?.[VPS_MANAGED_LABEL] === "1" ||
      LEGACY_VPS_MANAGED_LABELS.some((key) => labels?.[key] === "1");
    const namedByUs =
      labels?.[VPS_CONTAINER_LABEL] === status.container_name ||
      LEGACY_VPS_CONTAINER_LABELS.some((key) => labels?.[key] === status.container_name);
    status.managed = managedFlag && namedByUs;
    status.network = hasNoPublishedPorts(detail?.HostConfig, detail?.NetworkSettings?.Networks) ? "private" : "unsafe";
    status.mounts = hasNoHostMounts(detail ?? {}) ? "none" : "unsafe";
    // Compared against the budget this operator configured, not a constant:
    // a desktop built to a different size is one we no longer control, so it
    // is reported unsafe and replaced rather than silently reused.
    const size = vpsDesktopSize(cfg);
    status.security = dockerSecurityIsHardened(detail?.HostConfig, {
      restartPolicy: "unless-stopped",
      memoryBytes: size.memoryGib * GIB,
      nanoCpus: size.cpus * 1_000_000_000,
    })
      ? "hardened"
      : "unsafe";

    const connectionKey = `${alias}:${status.container_name}`;
    const privateIp = Object.values(detail?.NetworkSettings?.Networks ?? {})[0]?.IPAddress;
    const password = viewerPassword(detail?.Config?.Env);
    if (status.managed && privateIp && privateDockerIpv4(privateIp) && password) {
      viewerConnections.set(connectionKey, { privateIp, password });
    } else {
      viewerConnections.delete(connectionKey);
    }

    const containerRef = status.container_id;
    const canProbe =
      status.container === "running" &&
      status.image &&
      status.imageMatches &&
      status.managed &&
      status.network === "private" &&
      status.mounts === "none" &&
      status.security === "hardened";
    if (canProbe && containerRef) {
      try {
        const version = await run(cuaExecArgs(["--version"], { container: containerRef }));
        if (version.stdout.trim() !== `cua-driver ${CUA_DRIVER_VERSION}`) throw new Error("unexpected CUA Driver version");
        await run(cuaExecArgs(["status", "--socket", CUA_SOCKET], { container: containerRef }));
        const health = await run(
          cuaExecArgs(["call", "health_report", "{}", "--socket", CUA_SOCKET], { container: containerRef }),
          15_000,
        );
        const report = JSON.parse(health.stdout) as {
          schema_version?: string;
          overall?: string;
          checks?: unknown[];
        };
        if (
          report.schema_version !== "1" ||
          !Array.isArray(report.checks) ||
          (report.overall !== "ok" && report.overall !== "degraded")
        ) {
          throw new Error(`CUA health report is ${report.overall ?? "invalid"}`);
        }
        // The desktop must ANSWER, not render: get_desktop_state succeeding
        // is the readiness proof. The Local VM also pulls a pixel-validated
        // readiness screenshot because a local exec is free; over SSH that is
        // a full-frame base64 transfer on every status poll, so pixel
        // validation lives solely in vpsComputerScreenshot().
        await run(
          cuaExecArgs(["call", "get_desktop_state", "{}", "--socket", CUA_SOCKET], { container: containerRef }),
          20_000,
        );
        status.desktopReady = true;
      } catch (error) {
        status.desktopReady = false;
        status.desktop_error = error instanceof Error ? error.message.slice(0, 320) : null;
        // Mirror the Local VM's probe: when the desktop fails, the
        // supervisor's error log says WHY — a bounded tail turns an endless
        // "not ready yet" into something the user can act on.
        try {
          const errorLog = await run(
            ["exec", containerRef, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"],
            10_000,
          );
          status.desktop_error =
            errorLog.stdout.replace(/\s+/g, " ").trim().slice(0, 320) || status.desktop_error;
        } catch {
          // The log may not exist during the first seconds of container boot.
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingObjectMessage(message)) {
      status.container = "missing";
    } else {
      status.daemonUp = false;
      status.problem = transportFailure(message);
      return status;
    }
  }

  status.problem = statusProblem(status);
  status.ready = status.problem === null;
  return status;
}

/** Poll-facing status. Real SSH invocations (the default runner) are served
 * from a short TTL cache — the panel and the screen poller each re-check
 * every few seconds, and without the cache one healthy poll cycle cost a
 * dozen SSH connections. Injected runners (tests, lifecycle internals)
 * always recompute. */
export async function vpsComputerStatus(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  const key = vpsLockKey(cfg, botId);
  const cacheable = runner === defaultRunner && key !== null;
  if (cacheable) {
    const cached = statusCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.status;
  }
  const status = await computeVpsComputerStatus(cfg, botId, runner);
  if (cacheable) statusCache.set(key, { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
  return status;
}

export function vpsContainerRunArgs(
  containerName: string,
  imageRef = VPS_IMAGE,
  viewerSecret = randomBytes(18).toString("base64url"),
  size: VpsDesktopSize = { memoryGib: VPS_DEFAULT_MEMORY_GIB, cpus: VPS_DEFAULT_CPUS },
): string[] {
  if (!CONTAINER_NAME.test(containerName) || (imageRef !== VPS_IMAGE && !IMAGE_ID.test(imageRef))) {
    throw new Error("invalid managed VPS container or image reference");
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(viewerSecret)) throw new Error("invalid managed VPS viewer secret");
  return [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `${VPS_MANAGED_LABEL}=1`,
    "--label",
    `${VPS_CONTAINER_LABEL}=${containerName}`,
    "--label",
    `${VPS_VIEWER_LABEL}=${VIEWER_VERSION}`,
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`,
    "--label",
    `${BASE_IMAGE_LABEL}=${BASE_IMAGE_DIGEST}`,
    "--label",
    `${IMAGE_LAYER_LABEL}=${IMAGE_LAYER_VERSION}`,
    "--memory",
    `${size.memoryGib}g`,
    // memory-swap pinned to memory means no swap: a desktop that would swap
    // is one that has already lost, and on a shared host its swapping is
    // every other bot's problem.
    "--memory-swap",
    `${size.memoryGib}g`,
    "--cpus",
    String(size.cpus),
    "--pids-limit",
    String(PIDS_LIMIT),
    "--network",
    "bridge",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "SETUID",
    "--cap-add",
    "SETGID",
    "--shm-size",
    "512m",
    // A VPS reboots with nobody watching; without a restart policy the
    // container stays down afterwards and every turn silently degrades until
    // someone opens the panel. unless-stopped survives reboots while still
    // honoring an explicit Stop. The shared hardening check accepts exactly
    // this policy for the VPS caller (and only "no"/unset for the Local VM,
    // whose desktop cannot safely resume).
    "--restart",
    "unless-stopped",
    "-e",
    `VNC_PW=${viewerSecret}`,
    imageRef,
  ];
}

function assertUsableContainer(status: VpsComputerStatus) {
  if (
    !status.image ||
    !status.imageMatches ||
    !status.managed ||
    status.network !== "private" ||
    status.mounts !== "none" ||
    status.security !== "hardened"
  ) {
    throw Object.assign(new Error(status.problem ?? "The existing VPS container is unsafe or incompatible"), {
      status: 409,
    });
  }
}

async function prepareVpsImage(alias: string, runner: VpsCommandRunner) {
  await runner(vpsDockerArgs(alias, ["pull", BASE_IMAGE]), { timeoutMs: 10 * 60_000 });
  await runner(vpsDockerArgs(alias, ["build", "-t", VPS_IMAGE, "-"]), {
    input: managedImageDockerfile(),
    timeoutMs: 10 * 60_000,
  });
}

/** Waits for the driver inside a verified, running container to come up.
 * Backoff doubles 0.5s→4s because each poll is a real SSH connection, and
 * between polls only ONE cheap exec (`cua-driver status`) asks whether the
 * driver answers yet — the full multi-invocation status runs again only when
 * that predicate flips, and once more at the deadline, so the returned state
 * is always a complete inspection. */
async function waitForVpsReady(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner,
  budgetMs = 60_000,
): Promise<VpsComputerStatus> {
  const alias = vpsSshAlias(cfg);
  const deadline = Date.now() + budgetMs;
  let status = await computeVpsComputerStatus(cfg, botId, runner);
  let delayMs = 500;
  while (!status.ready && alias && Date.now() < deadline) {
    if (
      !status.daemonUp ||
      !status.image ||
      !status.imageMatches ||
      !status.managed ||
      status.container !== "running" ||
      status.network !== "private" ||
      status.mounts !== "none" ||
      status.security !== "hardened"
    ) {
      return status;
    }
    await new Promise((resolve) => {
      const sleep = setTimeout(resolve, Math.min(delayMs, Math.max(0, deadline - Date.now())));
      sleep.unref?.();
    });
    delayMs = Math.min(delayMs * 2, 4_000);
    const container = status.container_id ?? status.container_name;
    const driverAnswers = await runner(
      vpsDockerArgs(alias, cuaExecArgs(["status", "--socket", CUA_SOCKET], { container })),
      { timeoutMs: 30_000 },
    ).then(
      () => true,
      () => false,
    );
    if (!driverAnswers && Date.now() < deadline) continue;
    status = await computeVpsComputerStatus(cfg, botId, runner);
  }
  return status;
}

async function withVpsLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
  acquireTimeoutMs = LOCK_ACQUIRE_TIMEOUT_MS,
): Promise<T> {
  const previous = locks.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  if (previous) {
    let acquireTimer: ReturnType<typeof setTimeout> | undefined;
    const acquired = await Promise.race([
      previous.then(() => true),
      new Promise<boolean>((resolve) => {
        acquireTimer = setTimeout(() => resolve(false), acquireTimeoutMs);
        acquireTimer.unref?.();
      }),
    ]);
    if (acquireTimer) clearTimeout(acquireTimer);
    if (!acquired) {
      void previous.then(() => {
        release();
        if (locks.get(key) === current) locks.delete(key);
      });
      throw Object.assign(new Error("the VPS is being prepared — try again shortly"), { status: 409 });
    }
  }
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

async function withVpsLifecycleLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  return withVpsLock(lifecycleLocks, key, operation);
}

function vpsLockKey(cfg: AppConfig, botId: string): string | null {
  const alias = vpsSshAlias(cfg);
  return alias ? `${alias}:${vpsTargetFor(cfg, botId).containerName}` : null;
}

export async function vpsComputerAction(
  action: VpsLifecycleAction,
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured — add an SSH config alias in App Settings → Connections"), { status: 409 });
  const target = vpsTargetFor(cfg, botId);
  const key = `${alias}:${target.containerName}`;
  const operation = async () => {
    // A mutation invalidates every cached poll answer, before and after: the
    // panel must never keep showing the pre-action world for a TTL.
    statusCache.delete(key);
    try {
      const before = await computeVpsComputerStatus(cfg, botId, runner);
      if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? "Docker over SSH is not reachable"), { status: 409 });
      // A real lifecycle change invalidates the remote endpoint. Provision
      // is also the turn-start idempotency path, so leave an already-running
      // viewer alone when no start/replacement will occur.
      if (action !== "provision" || before.container !== "running") {
        if (isSharedVpsMode(cfg)) closeAllVpsDesktopTunnels();
        else stopDesktopTunnel(vpsOccupancyKey(cfg, botId));
      }
      const run = (args: string[], timeoutMs = 2 * 60_000) => runner(vpsDockerArgs(alias, args), { timeoutMs });

      const containerRef = before.container_id ?? before.container_name;
      if (action === "provision") {
        if (before.container === "missing") {
          let imageRef = before.image ? before.image_id : null;
          if (!before.image) {
            await prepareVpsImage(alias, runner);
            imageRef = (await computeVpsComputerStatus(cfg, botId, runner)).image_id;
          }
          if (!imageRef) throw Object.assign(new Error("The prepared VPS image could not be identified"), { status: 409 });
          await run(vpsContainerRunArgs(before.container_name, imageRef, undefined, vpsDesktopSize(cfg)));
        } else {
          assertUsableContainer(before);
          if (before.container === "stopped") await run(["start", containerRef]);
        }
      } else if (action === "start") {
        if (before.container === "missing") throw Object.assign(new Error("No VPS container exists for this bot"), { status: 409 });
        if (before.container === "running") throw Object.assign(new Error("The VPS container is already running"), { status: 409 });
        assertUsableContainer(before);
        await run(["start", containerRef]);
      } else if (action === "remove") {
        // remove exists to escape an incompatible or unsafe container (an
        // IMAGE_LAYER_VERSION bump otherwise bricks the bot: provision 409s
        // on assertUsableContainer forever), so it deliberately skips that
        // check. The ownership labels from the inspect are the only gate:
        // never docker-rm a container BotFleet did not create, even one
        // squatting on our name.
        if (before.container === "missing") return before;
        if (!before.managed) {
          throw Object.assign(
            new Error("The VPS container name is occupied by a container BotFleet did not create — remove it on the VPS yourself"),
            { status: 409 },
          );
        }
        await run(["rm", "-f", containerRef]);
        return computeVpsComputerStatus(cfg, botId, runner);
      } else {
        if (before.container !== "running") throw Object.assign(new Error("The VPS container is not running"), { status: 409 });
        assertUsableContainer(before);
        await run(["stop", containerRef]);
      }
      return action === "stop"
        ? await computeVpsComputerStatus(cfg, botId, runner)
        : await waitForVpsReady(cfg, botId, runner);
    } finally {
      statusCache.delete(key);
    }
  };
  let after: VpsComputerStatus;
  if (action === "provision" && isSharedVpsMode(cfg)) {
    // Every bot's turn-start provision targets the same container and is
    // idempotent, so concurrent ones share one flight instead of queueing.
    let flight = provisionFlights.get(key);
    if (!flight) {
      flight = withVpsLifecycleLock(key, operation).finally(() => {
        provisionFlights.delete(key);
      });
      provisionFlights.set(key, flight);
    }
    after = await flight;
  } else {
    after = await withVpsLifecycleLock(key, operation);
  }
  if (isSharedVpsMode(cfg) && after.ready && (after.container_id ?? after.container_name)) {
    await ensureSharedVpsBotSession(cfg, botId, after.container_id ?? after.container_name, runner);
  }
  if (cfg.localVm?.shareCliCredentials && after.ready && (action === "provision" || action === "start")) {
    await autoSyncCliCredentials(cfg, target, after.container_id ?? after.container_name, runner);
  }
  return after;

}

export interface VpsSyncCredentialsResult extends CredentialSyncResult {
  containerName: string;
}

/** Manifest-driven host → cloud VPS credential sync for every target
 * (shared cloud container and per-bot VPS containers). Settings and
 * per-bot Computer panels call this with `SHARED_VPS_TARGET` or
 * `vpsTargetFor(cfg, botId)`; auto-sync on provision/start uses the same path. */
export async function vpsSyncCliCredentials(
  cfg: AppConfig,
  target: VpsTarget = SHARED_VPS_TARGET,
  runner: VpsCommandRunner = defaultRunner,
  homeDir = process.env.HOME || process.env.USERPROFILE || homedir(),
): Promise<VpsSyncCredentialsResult> {
  const alias = vpsSshAlias(cfg);
  if (!alias) {
    throw Object.assign(
      new Error("VPS is not configured — add an SSH config alias in App Settings → Connections"),
      { status: 409 },
    );
  }

  const run = (args: string[], timeoutMs = 30_000, input?: string | Buffer) =>
    runner(vpsDockerArgs(alias, args), { timeoutMs, input });

  const inspectRaw = await run(["inspect", target.containerName]).catch(() => null);
  if (!inspectRaw) {
    throw Object.assign(new Error(`The VPS container ${target.containerName} does not exist`), { status: 404 });
  }

  let isRunning = false;
  try {
    const inspected = JSON.parse(inspectRaw.stdout) as Array<{ State?: { Running?: boolean } }>;
    isRunning = Boolean(inspected[0]?.State?.Running);
  } catch {
    // Malformed inspect output
  }

  if (!isRunning) {
    throw Object.assign(new Error(`The VPS container ${target.containerName} is not running`), { status: 409 });
  }

  const shareGpgPrivateKeys = Boolean(cfg.localVm?.shareGpgPrivateKeys);
  const { plan, cleanup } = await prepareCredentialSyncWorkspace(homeDir, { shareGpgPrivateKeys });
  try {
    const tarArchive = await packageCredentialArchive(homeDir, plan);
    if (!tarArchive) {
      return {
        ok: true,
        syncedTools: [],
        skippedTools: plan.skippedTools,
        containerName: target.containerName,
      };
    }

    await run(
      ["exec", "-i", "-u", "cua", target.containerName, "tar", "-xf", "-", "-C", "/home/cua"],
      60_000,
      tarArchive,
    );

    await run(["exec", "-u", "cua", target.containerName, "sh", "-c", credentialPermissionHardeningShell()], 15_000).catch(
      () => {},
    );

    return {
      ok: true,
      syncedTools: plan.syncedTools,
      skippedTools: plan.skippedTools,
      containerName: target.containerName,
    };
  } finally {
    await cleanup();
  }
}

/** Auto is intentionally read-only: it can attach only to an existing ready
 * container. It recomputes rather than reading the poll cache — routing a
 * turn onto a container that stopped seconds ago is worse than one extra
 * inspection at turn start. */
export async function reuseVps(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus | null> {
  const status = await inspectVpsForAuto(cfg, botId, runner);
  return status.ready ? status : null;
}

/** Auto needs the complete fresh status to explain a failed attach, while
 * retaining reuseVps's no-cache/no-mutation routing guarantee. */
export async function inspectVpsForAuto(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<VpsComputerStatus> {
  const key = vpsLockKey(cfg, botId);
  const status = key
    ? await withVpsLifecycleLock(key, () => computeVpsComputerStatus(cfg, botId, runner))
    : await computeVpsComputerStatus(cfg, botId, runner);
  if (isSharedVpsMode(cfg) && status.ready && (status.container_id ?? status.container_name)) {
    await ensureSharedVpsBotSession(cfg, botId, status.container_id ?? status.container_name, runner);
  }
  return status;
}

/** Open a temporary noVNC connection through the configured SSH alias. The
 * returned URL is loopback-only and contains the per-container password in
 * its fragment (never sent in HTTP). Closing the app viewer calls the paired
 * close endpoint, and process shutdown closes every remaining child. */
export async function vpsComputerJoin(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<{ joinUrl: string; state: "running" }> {
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured"), { status: 409 });
  const tunnelKey = vpsOccupancyKey(cfg, botId);

  const existing = desktopTunnels.get(tunnelKey);
  if (existing && existing.child.exitCode === null && !existing.child.killed) {
    return { joinUrl: existing.joinUrl, state: "running" };
  }
  stopDesktopTunnel(tunnelKey);

  // Always re-inspect here. A cached IP or password from before a container
  // replacement is exactly the sort of secret-bearing stale state a viewer
  // endpoint must not reuse.
  const status = await computeVpsComputerStatus(cfg, botId, runner);
  if (!status.ready) {
    throw Object.assign(new Error(status.problem ?? "The VPS computer is not ready"), { status: 409 });
  }
  const connection = viewerConnections.get(`${alias}:${status.container_name}`);
  if (!connection) {
    throw Object.assign(
      new Error("This VPS computer predates secure live desktop access — replace its managed container once"),
      { status: 409 },
    );
  }

  const localPort = await unusedLoopbackPort();
  const child = spawn("ssh", vpsSshTunnelArgs(alias, localPort, connection.privateIp), {
    shell: false,
    env: { ...process.env, PATH: augmentedPath() },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let failure: string | null = null;
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-1000);
  });
  child.once("error", (error) => {
    failure = error.message;
  });
  child.once("close", (code) => {
    const active = desktopTunnels.get(tunnelKey);
    if (active?.child === child) {
      clearTimeout(active.expiry);
      desktopTunnels.delete(tunnelKey);
    }
    if (!failure) failure = stderr.trim() || `SSH viewer tunnel exited ${code ?? "without a status"}`;
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !failure) {
    if (await loopbackAnswers(localPort)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (failure || !(await loopbackAnswers(localPort))) {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    const detail = failure || stderr.trim() || "the SSH port forward did not become ready";
    throw Object.assign(new Error(`Could not open the VPS live desktop: ${detail}`), { status: 502 });
  }

  const joinUrl = `http://127.0.0.1:${localPort}/vnc.html#autoconnect=true&resize=scale&password=${encodeURIComponent(connection.password)}`;
  // Viewer-close is the normal cleanup. This unref'd ceiling is a backstop
  // for a renderer crash or an old browser client that cannot signal close.
  const expiry = setTimeout(() => stopDesktopTunnel(tunnelKey), 8 * 60 * 60_000);
  expiry.unref?.();
  desktopTunnels.set(tunnelKey, { child, joinUrl, expiry });
  return { joinUrl, state: "running" };
}

export function vpsContainerMcpArgs(
  alias: string,
  containerName: string,
  socket: string = CUA_SOCKET,
  display: string = DISPLAY,
): string[] {
  if (!isValidSshAlias(alias) || (!CONTAINER_NAME.test(containerName) && !CONTAINER_ID.test(containerName))) {
    throw new Error("invalid VPS MCP connection");
  }
  if (!socket.startsWith("/run/user/1000/")) throw new Error("invalid VPS MCP socket");
  if (!/^:\d+$/.test(display)) throw new Error("invalid VPS MCP display");
  return vpsDockerArgs(
    alias,
    cuaExecArgs(["mcp", "--socket", socket], { container: containerName, interactive: true, display }),
  );
}

export function vpsComputerMcp(cfg: AppConfig, botId: string, containerRef?: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const alias = vpsSshAlias(cfg);
  if (!alias) throw new Error("VPS is not configured — add an SSH config alias first");
  const target = vpsTargetFor(cfg, botId);
  const socket = vpsDriverSocket(cfg, botId);
  const display = vpsDriverDisplay(cfg, botId);
  return {
    command: process.execPath,
    args: [
      SPAWNED_PROXIES.vpsContainerMcp,
      alias,
      containerRef ?? target.containerName,
      socket,
      display,
    ],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export {
  isSharedVpsMode,
  sharedVpsContainerLifecycleBlocked,
  vpsOccupancyKey,
} from "./vps-shared-session.ts";

/** Why this engine cannot take a self-hosted VPS, in the words a person
 *  reads.  The RULE lives in `computer-capability.ts` — this function owns
 *  only the copy, and picks which sentence explains the refusal. */
export function vpsDriverError(driverKind: string, reach: ComputerReach): string | null {
  if (reach.vps) return null;
  if (driverKind === "boxAgent") {
    return "The ASCII.dev Box engine runs its agent on Box and cannot use a self-hosted VPS — choose Claude or an ACP engine";
  }
  return "This model engine cannot mount a self-hosted VPS computer — choose Claude or an ACP engine";
}

export async function vpsComputerScreenshot(
  cfg: AppConfig,
  botId: string,
  runner: VpsCommandRunner = defaultRunner,
): Promise<{ png: string; format: "png" | "jpeg"; capturedAt: number }> {
  const alias = vpsSshAlias(cfg);
  if (!alias) throw Object.assign(new Error("VPS is not configured"), { status: 409 });
  const target = vpsTargetFor(cfg, botId);
  const key = `${alias}:${target.containerName}`;
  const cacheable = runner === defaultRunner;
  const loadStatus = async () => {
    const cached = cacheable ? statusCache.get(key) : undefined;
    if (cached && cached.expiresAt > Date.now()) return cached.status;
    return computeVpsComputerStatus(cfg, botId, runner);
  };
  const status = cacheable
    ? await withVpsLifecycleLock(key, loadStatus)
    : await loadStatus();
  if (!status.ready) {
    if (cacheable) statusCache.delete(key);
    throw Object.assign(new Error(status.problem ?? "The VPS computer is not ready"), { status: 409 });
  }
  if (cacheable) statusCache.set(key, { status, expiresAt: Date.now() + STATUS_CACHE_TTL_MS });
  const containerRef = status.container_id ?? status.container_name;
  if (!CONTAINER_ID.test(containerRef) && !CONTAINER_NAME.test(containerRef)) {
    throw Object.assign(new Error("the VPS container reference is malformed"), { status: 409 });
  }
  await ensureSharedVpsBotSession(cfg, botId, containerRef, runner);
  const socket = vpsDriverSocket(cfg, botId);
  const screenshotPath = vpsScreenshotPath(cfg, botId);
  const display = vpsDriverDisplay(cfg, botId);
  try {
    await runner(
      vpsDockerArgs(
        alias,
        cuaExecArgs(
          ["call", "get_desktop_state", "{}", "--socket", socket, "--screenshot-out-file", screenshotPath],
          { container: containerRef, display },
        ),
      ),
      { timeoutMs: 30_000 },
    );
    const encoded = (await runner(vpsDockerArgs(alias, [
      "exec",
      "-u",
      "cua",
      "-e",
      "HOME=/home/cua",
      containerRef,
      "base64",
      "-w0",
      screenshotPath,
    ]), { timeoutMs: 30_000 })).stdout.trim();
    const checked = wholeScreenshot(Buffer.from(encoded, "base64"));
    if (!checked.ok) throw Object.assign(new Error("CUA Driver returned an incomplete VPS screenshot"), { status: 502 });
    // Stamped here, between the pixels landing on the box and this returning,
    // rather than left to the client to stamp on receipt.  Everything before
    // this line — status check, lifecycle lock, SSH, the capture, the base64
    // read-back — is latency the client would otherwise charge to the picture
    // and use to decide it is newer than a streamed frame that beat it.
    return { png: encoded, format: checked.mime === "image/jpeg" ? "jpeg" : "png", capturedAt: Date.now() };
  } catch (error) {
    if (cacheable) statusCache.delete(key);
    throw error;
  } finally {
    await runner(vpsDockerArgs(alias, ["exec", "-u", "cua", containerRef, "rm", "-f", screenshotPath]), {
      timeoutMs: 10_000,
    }).catch(() => {});
  }
}

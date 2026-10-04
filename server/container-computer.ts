// Cua-backed Local VM lifecycle and health checks.
//
// BotFleet owns only the sandbox boundary: image preparation, container
// lifecycle, resource limits, loopback viewer, and target-scoped lease in the
// harness. Desktop automation itself is Cua Driver. Agents connect directly to
// `cua-driver mcp` inside the container; this module never reimplements clicks,
// typing, screenshots, accessibility, or window discovery.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { augmentedPath } from "./env-path.ts";
import { DATA_DIR, loadConfig, type AppConfig } from "./config.ts";
import {
  BOX_GATEWAY_PATH,
  boxGatewayGrants,
  resolveBoxGatewayGrant,
} from "./box-gateway-grant.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";

const run = promisify(execFile);
const SCREENSHOT_STATUS_TTL_MS = 10_000;

export type CommandRunner = (
  command: string,
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string }>;

export const CUA_DRIVER_VERSION = "0.20.0";
export const BASE_IMAGE_REPOSITORY = "docker.io/trycua/xfce-cua";
// Official multi-architecture Cua XFCE 0.1.0 manifest (amd64 + arm64).
export const BASE_IMAGE_DIGEST = "sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";
export const BASE_IMAGE = `${BASE_IMAGE_REPOSITORY}@${BASE_IMAGE_DIGEST}`;
// This tag is built locally from the pinned Cua base. The explicit localhost
// registry is required by Podman: it prepends localhost to unqualified build
// tags, then may otherwise resolve the same name to Docker Hub when running it.
// Image and container labels below remain the authoritative compatibility
// check, not the mutable tag.
export const IMAGE_REPOSITORY = "localhost/botfleet/cua-local-vm";
export const IMAGE_LAYER_VERSION = "5";
export const IMAGE_LAYER_LABEL = "com.botfleet.image-layer";
export const IMAGE = `${IMAGE_REPOSITORY}:driver-${CUA_DRIVER_VERSION}-v${IMAGE_LAYER_VERSION}`;
export const CONTAINER = `botfleet-computer-${userInfo().username}`;
const LEGACY_CONTAINER_PREFIXES = ["botfleet-computer", "openmausbot-computer", "opengrokbot-computer"] as const;
export const MANAGED_LABEL = "com.botfleet.local-vm";
export const DRIVER_LABEL = "com.botfleet.cua-driver";
export const BASE_IMAGE_LABEL = "com.botfleet.cua-base";
export const WORKSPACE_LABEL = "com.botfleet.workspace";
export const TARGET_LABEL = "com.botfleet.local-vm-target";
/** The Local VM workspace root, deliberately OUTSIDE `~/.botfleet`.
 *
 *  The desktop app opens anything under `DATA_DIR` on a single click from a
 *  bot's Markdown link — `resolveOpenablePath` in electron/open-file.mjs
 *  confines renderer-supplied paths to exactly that tree and then calls
 *  `shell.openPath`, and the "Reveal Data Folder" item hands the whole
 *  directory to the Finder.  A workspace inside that tree therefore turns a
 *  bot's sandbox into a file the user can be talked into opening, with
 *  whatever the bot had saved in it inside.
 *
 *  A sibling directory is outside every openable root, and it keeps the
 *  migration below a single rename because it is the same volume as
 *  `DATA_DIR`.  Deriving the name from `DATA_DIR` rather than hard-coding
 *  `~/.botfleet-vm` also keeps a test rig that sets `OMB_DATA_DIR` isolated. */
export const VM_WORKSPACE_ROOT = join(dirname(DATA_DIR), `${basename(DATA_DIR)}-vm`);
export const VM_WORKSPACE_DIR = join(VM_WORKSPACE_ROOT, "workspace");
/** Where the workspace lived before it moved out of the openable tree.  Read
 *  only so a pre-move workspace can be found and migrated in place; nothing
 *  creates a workspace here again. */
export const LEGACY_VM_WORKSPACE_DIR = join(DATA_DIR, "vm-home");
const LEGACY_VM_HOMES_DIR = join(DATA_DIR, "vm-homes");
export const VM_WORKSPACE_GUEST = "/home/cua/workspace";
export const DISPLAY = ":1";
export const CUA_SOCKET = "/run/user/1000/botfleet-cua.sock";
export const CUA_EXECUTABLE = "/usr/local/libexec/botfleet/cua-driver";

const RUNTIMES = ["docker", "podman", "container"] as const;
export type Runtime = (typeof RUNTIMES)[number];
export type LifecycleAction = "pull" | "run" | "start" | "stop" | "remove";

const INTERNAL_VIEWER_PORT = 6901;
const HOST_VIEWER_PORT = 6080;
/** Resource limits every managed container gets: the Local VM here and the
 * BYO-VPS container in vps-computer.ts.  PR #122 raised them from 4 GiB and
 * 2 CPUs to 8 GiB and 4 CPUs.  The run arguments and the inspect matchers
 * below are all derived from these two numbers so they cannot drift apart:
 * a container created with `--cpus 4` and then checked against 2 CPUs is
 * rejected as "unsafe" by the very runtime that created it. */
export const CONTAINER_MEMORY_GIB = 8;
export const CONTAINER_CPUS = 4;
export const CONTAINER_MEMORY_ARG = `${CONTAINER_MEMORY_GIB}g`;
export const CONTAINER_CPUS_ARG = String(CONTAINER_CPUS);
const MEMORY_BYTES = CONTAINER_MEMORY_GIB * 1024 * 1024 * 1024;
const NANO_CPUS = CONTAINER_CPUS * 1_000_000_000;
const PIDS_LIMIT = 512;
const SHM_BYTES = 512 * 1024 * 1024;

export interface LocalVmTarget {
  /** Stable, non-secret identity used for leases and caches. */
  key: string;
  containerName: string;
  workspaceDir: string;
  /** The historical shared target keeps 6080 for compatibility. Per-bot
   * targets let the runtime allocate a distinct ephemeral loopback port. */
  viewerPort: number | null;
  label: string;
  /** Per-bot desktop inside a shared container.
   *
   * Absent means the single `:1` desktop the container's supervisor started —
   * the historical behaviour, and what per-bot mode and the human noVNC
   * preview still use.  Present means this bot owns its own X display, Cua
   * socket and screenshot path inside the same container, which is what lets N
   * bots share one container.  Deliberately separate from `key`: `key`
   * identifies the CONTAINER (lifecycle and idle teardown must keep seeing one
   * desktop), while the session identifies the bot's desktop within it. */
  session?: {
    display: string;
    socket: string;
    session: string;
    screenshotPath: string;
  };
  /** Lease lane key, when the target's desktop belongs to one bot inside a
   * shared container.  Absent means the lane IS `key`. */
  laneKey?: string;
}

export const SHARED_LOCAL_VM_TARGET: LocalVmTarget = {
  key: "shared",
  containerName: CONTAINER,
  workspaceDir: VM_WORKSPACE_DIR,
  viewerPort: HOST_VIEWER_PORT,
  label: "shared",
};

/** Every Local VM target a workspace could have created, given the bots it
 * has.  The `shared` / `per-bot` mode decides which target a bot's turn
 * ADDRESSES, so a mode switch has to reckon with both sets at once: whatever
 * the outgoing mode left running is otherwise stranded — still holding its
 * ports, memory and durable workspace — with nothing left in the app that can
 * name it, and a lease held on any of them is a live turn clicking inside a
 * desktop the switch is about to remove.  Deduplicated by key, because a bot
 * can map onto the shared target. */
export function localVmModeSwitchTargets(botIds: readonly string[]): LocalVmTarget[] {
  const all = [SHARED_LOCAL_VM_TARGET, ...botIds.map((botId) => perBotLocalVmTarget(botId))];
  return all.filter((target, i) => all.findIndex((other) => other.key === target.key) === i);
}

/** Derive filesystem/container identities from a digest, never from a bot's
 * display name or caller-controlled path fragment. */
export function perBotLocalVmTarget(botId: string): LocalVmTarget {
  const digest = createHash("sha256").update(botId).digest("hex");
  const short = digest.slice(0, 16);
  return {
    key: `bot:${digest}`,
    containerName: `${CONTAINER}-${short}`,
    workspaceDir: join(VM_WORKSPACE_ROOT, "homes", short),
    viewerPort: null,
    label: digest,
  };
}

/** Where this target's workspace lived before the move out of the openable
 *  tree.  `shared` predates per-bot VMs and is the one that exists on disk for
 *  an install that has been running; a per-bot target's short hash is the last
 *  path segment, so its pre-move directory is recoverable from the target
 *  itself rather than from any caller. */
export function legacyVmWorkspaceDir(target: LocalVmTarget): string {
  return target.key === SHARED_LOCAL_VM_TARGET.key
    ? LEGACY_VM_WORKSPACE_DIR
    : join(LEGACY_VM_HOMES_DIR, basename(target.workspaceDir));
}

/** Both paths a target's workspace may legitimately be at: the current one and
 *  its pre-move location.  The mount check has to accept the second, or a
 *  Local VM that is still running from before the move reads as "unsafe
 *  workspace" in the panel until the user removes and recreates it. */
export function workspaceSources(target: LocalVmTarget): string[] {
  const sources = [target.workspaceDir, legacyVmWorkspaceDir(target)];
  return sources.filter((value, i) => sources.indexOf(value) === i);
}

const LINUX_WHEELS = {
  x86_64: {
    url: "https://files.pythonhosted.org/packages/fa/d7/a43008a328a40c85e7bc706fc20235b9abedc75e28b413817655153157ff/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl",
    sha256: "f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961",
  },
  aarch64: {
    url: "https://files.pythonhosted.org/packages/94/9d/1c1838b69067e83266c3d2aae02d74eef353a43dc8644884ccf03fe7f933/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl",
    sha256: "48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77",
  },
} as const;

/** Reproducible, multi-architecture derivative of Cua's sandbox desktop.
 * Both Linux wheels are exact-version and SHA-256 verified. Supervisor owns
 * the daemon so it starts, restarts, and stops with the desktop container.
 *
 * The first RUN also rejects a defective base image before anything uses it:
 * some published ARM64 layers of upstream bases have shipped zero-byte
 * OpenSSL libraries, which surfaces later as a baffling "curl: error while
 * loading shared libraries … file too short" that reads as a network fault.
 * The gate names the actual problem at the step that can act on it. */
export function managedImageDockerfile(): string {
  return `FROM ${BASE_IMAGE}
USER root
RUN set -eux; \\
    arch="$(uname -m)"; \\
    case "$arch" in \\
      x86_64) wheel_url='${LINUX_WHEELS.x86_64.url}'; wheel_sha='${LINUX_WHEELS.x86_64.sha256}'; wheel_path='/tmp/cua_driver-${CUA_DRIVER_VERSION}-py3-none-manylinux_2_31_x86_64.whl'; lib_triplet='x86_64-linux-gnu' ;; \\
      aarch64|arm64) wheel_url='${LINUX_WHEELS.aarch64.url}'; wheel_sha='${LINUX_WHEELS.aarch64.sha256}'; wheel_path='/tmp/cua_driver-${CUA_DRIVER_VERSION}-py3-none-manylinux_2_31_aarch64.whl'; lib_triplet='aarch64-linux-gnu' ;; \\
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \\
    esac; \\
    for ssl_lib in "/lib/$lib_triplet/libssl.so.3" "/lib/$lib_triplet/libcrypto.so.3"; do \\
      if [ -e "$ssl_lib" ] && [ ! -s "$ssl_lib" ]; then \\
        echo "pinned base image is defective on $arch: $ssl_lib is zero bytes, so curl cannot start — re-pull or replace the base image instead of debugging the wheel download" >&2; \\
        exit 1; \\
      fi; \\
    done; \\
    curl -fsSL "$wheel_url" -o "$wheel_path"; \\
    echo "$wheel_sha  $wheel_path" | sha256sum -c -; \\
    /opt/venv/bin/python -m pip install --no-cache-dir --force-reinstall --no-deps "$wheel_path"; \\
    rm -f "$wheel_path"; \\
    driver_bin="$(find /opt/venv/lib -path '*/cua_driver/bin/cua-driver' -type f -print -quit)"; \\
    test -n "$driver_bin"; \\
    install -D -m 0755 "$driver_bin" ${CUA_EXECUTABLE}; \\
    install -d -o cua -g cua -m 0700 ${VM_WORKSPACE_GUEST}; \\
    test "$(${CUA_EXECUTABLE} --version)" = "cua-driver ${CUA_DRIVER_VERSION}"
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      'set -eu' \\
      'workspace=${VM_WORKSPACE_GUEST}' \\
      'profiles="$workspace/.browser-profiles"' \\
      'mkdir -p "$profiles/google-chrome" "$profiles/chromium" "$HOME/.config"' \\
      'if ! chmod 0700 "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium" 2>/dev/null; then' \\
      '  for directory in "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium"; do' \\
      '    test -r "$directory" && test -w "$directory" && test -x "$directory"' \\
      '  done' \\
      'fi' \\
      'migrate_profile() {' \\
      '  name="$1"' \\
      '  source="$HOME/.config/$name"' \\
      '  target="$profiles/$name"' \\
      '  if [ -d "$source" ] && [ ! -L "$source" ] && [ -z "$(find "$target" -mindepth 1 -print -quit)" ]; then' \\
      '    cp -a "$source"/. "$target"/' \\
      '  fi' \\
      '  rm -rf "$source"' \\
      '  ln -s "$target" "$source"' \\
      '}' \\
      'migrate_profile google-chrome' \\
      'migrate_profile chromium' \\
      'find "$profiles" \\( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie -o -name .parentlock \\) -delete' \\
      > /usr/local/bin/prepare-botfleet-workspace.sh \\
    && chmod 0755 /usr/local/bin/prepare-botfleet-workspace.sh
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      '/usr/local/bin/prepare-botfleet-workspace.sh' \\
      'attempt=0' \\
      'until DISPLAY=:1 xset q >/dev/null 2>&1; do' \\
      '  attempt=$((attempt + 1))' \\
      '  if [ "$attempt" -ge 45 ]; then echo "X display :1 did not become ready within 45 seconds" >&2; exit 1; fi' \\
      '  sleep 1' \\
      'done' \\
      'exec env CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CUA_EXECUTABLE} serve --socket ${CUA_SOCKET} --permission-mode standard' \\
      > /usr/local/bin/start-botfleet-cua-driver.sh \\
    && chmod 0755 /usr/local/bin/start-botfleet-cua-driver.sh
RUN printf '%s\\n' \\
      '' \\
      '[program:botfleet-cua-driver]' \\
      'command=/usr/local/bin/start-botfleet-cua-driver.sh' \\
      'user=cua' \\
      'environment=HOME="/home/cua",USER="cua",DISPLAY=":1"' \\
      'autorestart=true' \\
      'startsecs=2' \\
      'stdout_logfile=/var/log/supervisor/cua-driver.log' \\
      'stderr_logfile=/var/log/supervisor/cua-driver.error.log' \\
      'priority=30' \\
      >> /etc/supervisor/supervisord.conf
LABEL ${MANAGED_LABEL}="1" \\
      ${DRIVER_LABEL}="${CUA_DRIVER_VERSION}" \\
      ${BASE_IMAGE_LABEL}="${BASE_IMAGE_DIGEST}" \\
      ${IMAGE_LAYER_LABEL}="${IMAGE_LAYER_VERSION}"
`;
}

async function sh(cmd: string, args: string[], timeout = 8000): Promise<{ stdout: string }> {
  const { stdout } = await run(cmd, args, {
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: augmentedPath() },
  });
  return { stdout };
}

async function installed(
  cmd: string,
  runner: CommandRunner,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    await runner(platform === "win32" ? "where.exe" : "/usr/bin/which", [cmd], 4000);
    return true;
  } catch {
    return false;
  }
}

export interface ContainerRuntimeStatus {
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
}

/** Inspect only the host runtime. Unlike a full Local VM status check, this
 * never opens a container, calls Cua, or reads a desktop screenshot. */
export async function containerRuntimeStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
): Promise<ContainerRuntimeStatus> {
  // Podman is the supported Windows VM lane and owns the pinned managed image.
  // Docker may also be installed and healthy on the same host, so the generic
  // Docker-first order would silently select an empty, unrelated image store.
  const candidates: Runtime[] = platform === "win32"
    ? ["podman", "docker"]
    : RUNTIMES.filter((runtime) => runtime !== "container" || platform === "darwin");
  const present = await Promise.all(candidates.map((runtime) => installed(runtime, runner, platform)));
  const available = candidates.filter((_, index) => present[index]);
  const healthy = await Promise.all(
    available.map(async (candidate) => {
      try {
        const infoArgs = candidate === "container"
          ? ["system", "status"]
          : candidate === "podman"
            ? ["info", "--format", "json"]
            : ["info", "--format", "{{.ServerVersion}}"];
        await runner(
          candidate,
          infoArgs,
          10_000,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
  const healthyIndex = healthy.indexOf(true);
  return {
    runtime: healthyIndex >= 0 ? available[healthyIndex] : (available[0] ?? null),
    available,
    daemonUp: healthyIndex >= 0,
  };
}

export interface ContainerComputerStatus {
  platform: NodeJS.Platform;
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  desktop_error: string | null;
  create_supported: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  image_id: string | null;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  target_key: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_port: number | null;
  viewer_url: string;
}

function emptyStatus(platform: NodeJS.Platform, target: LocalVmTarget): ContainerComputerStatus {
  return {
    platform,
    runtime: null,
    available: [],
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    security: "unknown",
    persistence: "unknown",
    desktopReady: false,
    desktop_error: null,
    create_supported: true,
    ready: false,
    problem: "Install a supported container runtime first",
    image_ref: IMAGE,
    image_id: null,
    base_image_ref: BASE_IMAGE,
    driver_version: CUA_DRIVER_VERSION,
    container_name: target.containerName,
    target_key: target.key,
    workspace_path: target.workspaceDir,
    workspace_guest_path: VM_WORKSPACE_GUEST,
    viewer_port: target.viewerPort,
    viewer_url: target.viewerPort ? `http://127.0.0.1:${target.viewerPort}/vnc.html` : "",
  };
}

function statusProblem(status: ContainerComputerStatus): string | null {
  if (!status.runtime) return "Install a supported container runtime first";
  if (!status.daemonUp) return `Start ${status.runtime} first`;
  if (!status.image) return `Prepare the Cua desktop image with Driver ${CUA_DRIVER_VERSION}`;
  if (status.container === "missing" && !status.create_supported) {
    return "Per-bot Local VMs require Docker or Podman because Apple container requires a fixed host port";
  }
  if (status.container === "missing") return "Create the Local VM";
  if (!status.imageMatches) return "The existing Local VM uses an older desktop or Cua Driver; recreate it";
  if (!status.managed) return "The existing container was not created by BotFleet; recreate it";
  if (status.network === "unsafe") return "The existing Local VM exposes its viewer publicly; recreate it";
  if (status.security === "unsafe") return "The existing Local VM is missing safety limits; recreate it";
  if (status.persistence === "unsafe") return "The existing Local VM is missing its durable workspace; recreate it";
  if (status.container === "stopped") return "This desktop image cannot safely resume; recreate the Local VM";
  if (status.desktop_error) return `The Local VM desktop failed to start: ${status.desktop_error}`;
  if (!status.desktopReady) return "The Local VM started, but Cua Driver is not ready yet";
  return null;
}

/** Shared with the BYO-VPS backend (vps-computer.ts): both containers are
 * built from the same pinned derivative, so image compatibility is one rule. */
export function imageLabelsMatch(labels: Record<string, string> | undefined): boolean {
  const layer = labels?.[IMAGE_LAYER_LABEL];
  const layerMatches = layer === IMAGE_LAYER_VERSION || layer === `v${IMAGE_LAYER_VERSION}`;
  return (
    labels?.[MANAGED_LABEL] === "1" &&
    labels?.[DRIVER_LABEL] === CUA_DRIVER_VERSION &&
    labels?.[BASE_IMAGE_LABEL] === BASE_IMAGE_DIGEST &&
    layerMatches
  );
}

function containerLabelsMatch(
  labels: Record<string, string> | undefined,
  target: LocalVmTarget,
): boolean {
  return (
    imageLabelsMatch(labels) &&
    labels?.[WORKSPACE_LABEL] === "1" &&
    (target.key === SHARED_LOCAL_VM_TARGET.key
      ? labels?.[TARGET_LABEL] === undefined || labels?.[TARGET_LABEL] === target.label
      : labels?.[TARGET_LABEL] === target.label)
  );
}

function normalizeImageId(id: string | undefined): string | null {
  return id?.trim().replace(/^sha256:/, "") || null;
}

function inspectedImage(stdout: string): {
  labels: Record<string, string> | undefined;
  id: string | null;
} {
  const parsed = JSON.parse(stdout) as Array<{
    Id?: string;
    id?: string;
    Config?: { Labels?: Record<string, string> };
    config?: { Labels?: Record<string, string>; labels?: Record<string, string> };
    configuration?: { labels?: Record<string, string>; descriptor?: { digest?: string } };
  }>;
  const image = parsed[0];
  return {
    labels:
      image?.Config?.Labels ?? image?.config?.Labels ?? image?.config?.labels ?? image?.configuration?.labels,
    id: normalizeImageId(image?.Id ?? image?.id ?? image?.configuration?.descriptor?.digest),
  };
}

function viewerPassword(env: string[] | Record<string, string> | undefined): string | null {
  if (Array.isArray(env)) {
    return env.find((entry) => entry.startsWith("VNC_PW="))?.slice("VNC_PW=".length) || null;
  }
  return env?.VNC_PW || null;
}

function viewerUrl(password: string | null, port: number | null): string {
  if (!port) return "";
  const base = `http://127.0.0.1:${port}/vnc.html`;
  if (!password) return base;
  const fragment = new URLSearchParams({ autoconnect: "true", resize: "scale", password });
  return `${base}#${fragment.toString()}`;
}

/** The one authoritative `exec … cua-driver` argv. Shared with the BYO-VPS
 * backend and both MCP bridge entry points so the identity, env, and
 * telemetry knobs can never drift between the Local VM and a VPS container. */
export function cuaExecArgs(
  args: string[],
  options: { container?: string; interactive?: boolean; display?: string; command?: string } = {},
): string[] {
  return [
    "exec",
    ...(options.interactive ? ["-i"] : []),
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    `DISPLAY=${options.display ?? DISPLAY}`,
    "-e",
    "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    "-e",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
    options.container ?? CONTAINER,
    // Defaults to the driver binary; a caller that needs to run something else
    // inside the same exec (the per-bot session ensure runs a shell script)
    // passes it here rather than rebuilding the argv.
    options.command ?? CUA_EXECUTABLE,
    ...args,
  ];
}

export async function containerComputerStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<ContainerComputerStatus> {
  const status = emptyStatus(platform, target);
  const runtimeStatus = await containerRuntimeStatus(runner, platform);
  status.available = runtimeStatus.available;
  status.runtime = runtimeStatus.runtime;
  status.daemonUp = runtimeStatus.daemonUp;
  status.create_supported = target.key === SHARED_LOCAL_VM_TARGET.key || status.runtime !== "container";
  if (!status.runtime || !status.daemonUp) {
    status.problem = statusProblem(status);
    return status;
  }

  try {
    await runner(status.runtime, ["inspect", target.containerName]);
  } catch {
    for (const prefix of LEGACY_CONTAINER_PREFIXES) {
      const legacy =
        target.containerName === CONTAINER
          ? prefix
          : target.containerName.replace(CONTAINER, prefix);
      try {
        await runner(status.runtime, ["inspect", legacy]);
        await runner(status.runtime, ["rename", legacy, target.containerName]);
        break;
      } catch {
        /* predecessor missing, or rename lost the race — try the next name */
      }
    }
  }

  try {
    const { stdout } = await runner(status.runtime, ["image", "inspect", IMAGE]);
    const image = inspectedImage(stdout);
    status.image = imageLabelsMatch(image.labels);
    status.image_id = image.id;
  } catch {
    // The prepared BotFleet derivative has not been built yet.
  }

  try {
    const { stdout } = await runner(status.runtime, ["inspect", target.containerName]);
    if (status.runtime === "container") {
      const inspected = JSON.parse(stdout) as Array<{
        configuration?: {
          image?: string | { reference?: string; descriptor?: { digest?: string } };
          imageReference?: string;
          resources?: { cpus?: number; memoryInBytes?: number };
          publishedPorts?: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }>;
          environment?: string[] | Record<string, string>;
          labels?: Record<string, string>;
          mounts?: Array<{ source?: string; destination?: string; options?: string[] }>;
        };
        status?: { state?: string };
      }>;
      const detail = inspected[0];
      status.container = detail?.status?.state === "running" ? "running" : "stopped";
      status.network = applePortsAreLocal(detail?.configuration?.publishedPorts) ? "loopback" : "unsafe";
      status.viewer_port = appleViewerPort(detail?.configuration?.publishedPorts, target.viewerPort);
      const appleImage =
        typeof detail?.configuration?.image === "string"
          ? detail.configuration.image
          : detail?.configuration?.image?.reference ?? detail?.configuration?.imageReference;
      const appleImageId =
        typeof detail?.configuration?.image === "object"
          ? normalizeImageId(detail.configuration.image.descriptor?.digest)
          : null;
      status.imageMatches =
        appleImage === IMAGE && status.image_id !== null && appleImageId === status.image_id;
      status.managed = containerLabelsMatch(detail?.configuration?.labels, target);
      status.persistence = appleWorkspaceMountIsSafe(detail?.configuration?.mounts, platform, workspaceSources(target))
        ? "durable"
        : "unsafe";
      const resources = detail?.configuration?.resources;
      status.security =
        (resources?.memoryInBytes ?? 0) >= MEMORY_BYTES && resources?.cpus === CONTAINER_CPUS ? "hardened" : "unsafe";
      status.viewer_url = viewerUrl(viewerPassword(detail?.configuration?.environment), status.viewer_port);
    } else {
      const inspected = JSON.parse(stdout) as Array<{
        Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
        HostConfig?: DockerHardeningConfig & {
          PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
        };
        NetworkSettings?: {
          Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
        };
        Mounts?: Array<{
          Type?: string;
          Source?: string;
          Destination?: string;
          RW?: boolean;
        }>;
        EffectiveCaps?: string[];
        BoundingCaps?: string[];
        State?: { Running?: boolean };
        Image?: string;
      }>;
      const detail = inspected[0];
      status.container = detail?.State?.Running ? "running" : "stopped";
      status.network = dockerPortsAreLocal(detail?.HostConfig?.PortBindings) ? "loopback" : "unsafe";
      status.viewer_port = dockerViewerPort(detail?.NetworkSettings?.Ports, target.viewerPort);
      status.imageMatches =
        detail?.Config?.Image === IMAGE &&
        imageLabelsMatch(detail?.Config?.Labels) &&
        status.image_id !== null &&
        normalizeImageId(detail?.Image) === status.image_id;
      status.managed = containerLabelsMatch(detail?.Config?.Labels, target);
      status.persistence = dockerWorkspaceMountIsSafe(
        detail?.Mounts,
        platform,
        workspaceSources(target),
        status.runtime,
      ) ? "durable" : "unsafe";
      status.security = (
        status.runtime === "podman"
          ? podmanSecurityIsHardened(detail?.HostConfig, detail?.EffectiveCaps, detail?.BoundingCaps)
          : dockerSecurityIsHardened(detail?.HostConfig)
      ) ? "hardened" : "unsafe";
      status.viewer_url = viewerUrl(viewerPassword(detail?.Config?.Env), status.viewer_port);
    }
  } catch {
    // No container with this name.
  }

  const canProbe =
    status.container === "running" &&
    status.imageMatches &&
    status.managed &&
    status.network === "loopback" &&
    status.security === "hardened" &&
    status.persistence === "durable";
  if (canProbe) {
    try {
      const expected = `cua-driver ${CUA_DRIVER_VERSION}`;
      const version = await runner(status.runtime, cuaExecArgs(["--version"], { container: target.containerName }), 8000);
      if (version.stdout.trim() !== expected) throw new Error(`expected ${expected}`);
      await runner(status.runtime, cuaExecArgs(["status", "--socket", CUA_SOCKET], { container: target.containerName }), 8000);
      const health = await runner(
        status.runtime,
        cuaExecArgs(["call", "health_report", "{}", "--socket", CUA_SOCKET], { container: target.containerName }),
        15_000,
      );
      const report = JSON.parse(health.stdout) as { schema_version?: string; overall?: string; checks?: unknown[] };
      if (
        report.schema_version !== "1" ||
        !Array.isArray(report.checks) ||
        (report.overall !== "ok" && report.overall !== "degraded")
      ) {
        throw new Error(`Cua health report is ${report.overall ?? "invalid"}`);
      }
      const readinessShot = "/tmp/botfleet-readiness.png";
      await runner(
        status.runtime,
        cuaExecArgs([
          "call",
          "get_desktop_state",
          "{}",
          "--socket",
          CUA_SOCKET,
          "--screenshot-out-file",
          readinessShot,
        ], { container: target.containerName }),
        20_000,
      );
      const captured = await runner(
        status.runtime,
        ["exec", target.containerName, "base64", "-w0", readinessShot],
        20_000,
      );
      if (!wholeScreenshot(Buffer.from(captured.stdout.trim(), "base64")).ok) {
        throw new Error("Cua Driver returned an incomplete readiness screenshot");
      }
      status.desktopReady = true;
    } catch (error) {
      // An empty log means XFCE and the supervisor-owned Cua daemon are
      // probably still starting. A real startup failure should be actionable
      // in the panel instead of looking like an endless readiness wait.
      status.desktop_error = error instanceof Error ? error.message.slice(0, 320) : null;
      try {
        const errorLog = await runner(
          status.runtime,
          ["exec", target.containerName, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"],
          4000,
        );
        status.desktop_error =
          errorLog.stdout.replace(/\s+/g, " ").trim().slice(0, 320) ||
          status.desktop_error;
      } catch {
        // The log may not exist during the first seconds of container boot.
      }
    }
  }

  status.problem = statusProblem(status);
  status.ready = status.problem === null;
  return status;
}

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "[::1]";
}

function dockerPortsAreLocal(
  bindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined,
): boolean {
  const viewer = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`] ?? [];
  const published = Object.values(bindings ?? {}).flatMap((entries) => entries ?? []);
  return viewer.length > 0 && published.length === viewer.length && published.every((entry) => loopback(entry.HostIp));
}

function dockerViewerPort(
  bindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined,
  fallback: number | null,
): number | null {
  const raw = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`]?.find((entry) => loopback(entry.HostIp))?.HostPort;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function applePortsAreLocal(
  bindings: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }> | undefined,
): boolean {
  return Boolean(
    bindings?.length === 1 &&
      bindings[0]?.containerPort === INTERNAL_VIEWER_PORT &&
      loopback(bindings[0]?.hostAddress),
  );
}

function appleViewerPort(
  bindings: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }> | undefined,
  fallback: number | null,
): number | null {
  const raw = bindings?.find(
    (binding) => binding.containerPort === INTERNAL_VIEWER_PORT && loopback(binding.hostAddress),
  )?.hostPort;
  return Number.isInteger(raw) && Number(raw) > 0 && Number(raw) <= 65_535 ? Number(raw) : fallback;
}

function sameWorkspaceSource(
  source: string | undefined,
  platform: NodeJS.Platform,
  expectedWorkspace: string,
): boolean {
  if (!source) return false;
  const actual = resolve(source);
  const expected = resolve(expectedWorkspace);
  return platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

/** Podman Machine exposes a Windows bind source through its WSL mount path.
 * Accept only the exact drive/path translation; no parent or prefix match. */
function samePodmanWindowsWorkspaceSource(source: string | undefined, expectedWorkspace: string): boolean {
  if (!source) return false;
  const match = expectedWorkspace.match(/^([A-Za-z]):[\\/](.+)$/);
  if (!match) return false;
  const expected = `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
  const actual = source.replaceAll("\\", "/");
  return actual.toLowerCase() === expected.toLowerCase();
}

export interface HostCliCredentialCandidate {
  relPath: string[];
  guest: string;
}

export const CLI_CREDENTIAL_CANDIDATES: readonly HostCliCredentialCandidate[] = [
  // Infisical CLI
  { relPath: [".infisical"], guest: "/home/cua/.infisical" },
  { relPath: [".config", "infisical"], guest: "/home/cua/.config/infisical" },

  // SSH & Git
  { relPath: [".ssh"], guest: "/home/cua/.ssh" },
  { relPath: [".gitconfig"], guest: "/home/cua/.gitconfig" },
  { relPath: [".config", "git"], guest: "/home/cua/.config/git" },
  { relPath: [".config", "gh"], guest: "/home/cua/.config/gh" },
  { relPath: [".netrc"], guest: "/home/cua/.netrc" },

  // Cloud Providers
  { relPath: [".aws"], guest: "/home/cua/.aws" },
  { relPath: [".config", "gcloud"], guest: "/home/cua/.config/gcloud" },
  { relPath: [".azure"], guest: "/home/cua/.azure" },
  { relPath: [".oci"], guest: "/home/cua/.oci" },

  // Container & Kubernetes
  { relPath: [".docker", "config.json"], guest: "/home/cua/.docker/config.json" },
  { relPath: [".kube"], guest: "/home/cua/.kube" },

  // Package Managers & Toolchains
  { relPath: [".npmrc"], guest: "/home/cua/.npmrc" },
  { relPath: [".cargo", "credentials.toml"], guest: "/home/cua/.cargo/credentials.toml" },
  { relPath: [".cargo", "credentials"], guest: "/home/cua/.cargo/credentials" },
  { relPath: [".cargo", "config.toml"], guest: "/home/cua/.cargo/config.toml" },
  { relPath: [".cargo", "config"], guest: "/home/cua/.cargo/config" },
  { relPath: [".pypirc"], guest: "/home/cua/.pypirc" },

  // Hosting & Platform CLIs
  { relPath: [".vercel"], guest: "/home/cua/.vercel" },
  { relPath: [".fly"], guest: "/home/cua/.fly" },
  { relPath: [".config", "cloudflare"], guest: "/home/cua/.config/cloudflare" },
  { relPath: [".wrangler"], guest: "/home/cua/.wrangler" },

  // Developer APIs & Tools
  { relPath: [".config", "stripe"], guest: "/home/cua/.config/stripe" },
  { relPath: [".config", "supabase"], guest: "/home/cua/.config/supabase" },
  { relPath: [".config", "huggingface"], guest: "/home/cua/.config/huggingface" },
  { relPath: [".sentryclirc"], guest: "/home/cua/.sentryclirc" },
  { relPath: [".terraform.d"], guest: "/home/cua/.terraform.d" },
] as const;

export const ALLOWED_CLI_GUEST_DESTINATIONS: ReadonlySet<string> = new Set(
  CLI_CREDENTIAL_CANDIDATES.map((c) => c.guest),
);

function dockerWorkspaceMountIsSafe(
  mounts:
    | Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>
    | undefined,
  platform: NodeJS.Platform,
  expectedWorkspace: string | readonly string[],
  runtime: Runtime = "docker",
): boolean {
  if (!mounts || mounts.length === 0) return false;
  // Both the current path and the pre-move one count: a Local VM started
  // before the workspace moved out of the openable tree is still correctly
  // bound, it is just bound to where it was created.
  const expected = Array.isArray(expectedWorkspace) ? expectedWorkspace : [expectedWorkspace];
  const workspaceMount = mounts.find((m) => m.Destination === VM_WORKSPACE_GUEST);
  if (!workspaceMount || workspaceMount.Type !== "bind" || workspaceMount.RW === false) return false;

  const sourceMatches =
    expected.some((candidate) => sameWorkspaceSource(workspaceMount.Source, platform, candidate)) ||
    (runtime === "podman" && platform === "win32" && expected.some((candidate) => samePodmanWindowsWorkspaceSource(workspaceMount.Source, candidate)));
  if (!sourceMatches) return false;

  for (const mount of mounts) {
    if (mount === workspaceMount) continue;
    if (mount.Type !== "bind" || mount.RW !== false) return false;
    if (!mount.Destination || !ALLOWED_CLI_GUEST_DESTINATIONS.has(mount.Destination)) return false;
  }
  return true;
}

function appleWorkspaceMountIsSafe(
  mounts: Array<{ source?: string; destination?: string; options?: string[] }> | undefined,
  platform: NodeJS.Platform,
  expectedWorkspace: string | readonly string[],
): boolean {
  if (!mounts || mounts.length === 0) return false;
  const expected = Array.isArray(expectedWorkspace) ? expectedWorkspace : [expectedWorkspace];
  const workspaceMount = mounts.find((m) => m.destination === VM_WORKSPACE_GUEST);
  if (!workspaceMount) return false;
  const wsOptions = workspaceMount.options ?? [];
  if (wsOptions.some((option) => option === "ro" || option === "readonly")) return false;
  if (!expected.some((candidate) => sameWorkspaceSource(workspaceMount.source, platform, candidate))) return false;

  for (const mount of mounts) {
    if (mount === workspaceMount) continue;
    const options = mount.options ?? [];
    const isReadOnly = options.some((opt) => opt === "ro" || opt === "readonly");
    if (!isReadOnly) return false;
    if (!mount.destination || !ALLOWED_CLI_GUEST_DESTINATIONS.has(mount.destination)) return false;
  }
  return true;
}

/** The Docker/Podman HostConfig surface the hardening check reads. */
export interface DockerHardeningConfig {
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  PidsLimit?: number | null;
  CapDrop?: string[] | null;
  CapAdd?: string[] | null;
  Privileged?: boolean;
  PidMode?: string;
  IpcMode?: string;
  UTSMode?: string;
  ShmSize?: number;
  Devices?: unknown[] | null;
  DeviceRequests?: unknown[] | null;
  SecurityOpt?: string[] | null;
  UsernsMode?: string;
  CgroupnsMode?: string;
  OomKillDisable?: boolean | null;
  AutoRemove?: boolean;
  RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
}

/** One hardening contract for both managed containers (Local VM here, the
 * BYO-VPS backend in vps-computer.ts): exact resource limits, no privilege,
 * no host namespaces or devices, no disabled security profiles.
 *
 * Two knobs the callers legitimately disagree on. The restart policy: the VPS
 * container must survive a reboot nobody is watching ("unless-stopped"),
 * while the Local VM must NOT auto-resume — its desktop leaves a stale X lock
 * on stop, so a restarted container is a broken one. And the resource budget:
 * the Local VM is the only desktop on the person's own workstation, whereas a
 * VPS hosts one desktop PER BOT on a single shared machine, so it is sized as
 * a fraction of that host.
 *
 * The limits are still compared exactly, not as a floor. That is the point:
 * a container built with different limits than the caller now asks for is a
 * container the caller no longer controls, so it is reported unsafe and
 * replaced rather than quietly accepted. Callers pass the caps they used to
 * create it; the defaults are the Local VM's. */
export function dockerSecurityIsHardened(
  config: DockerHardeningConfig | undefined,
  options: {
    restartPolicy?: "no" | "unless-stopped";
    memoryBytes?: number;
    nanoCpus?: number;
  } = {},
): boolean {
  if (!config) return false;
  const capDrop = (config.CapDrop ?? []).map((cap) => cap.toLowerCase());
  const capAdd = (config.CapAdd ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  const unsafeSecurityOption = (config.SecurityOpt ?? []).some((option) => /(?:^|=)(?:unconfined|disable)$/i.test(option));
  const restartPolicy = config.RestartPolicy?.Name;
  const restartPolicyOk =
    options.restartPolicy === "unless-stopped"
      ? restartPolicy === "unless-stopped"
      : restartPolicy === undefined || restartPolicy === "" || restartPolicy === "no";
  const memoryBytes = options.memoryBytes ?? MEMORY_BYTES;
  const nanoCpus = options.nanoCpus ?? NANO_CPUS;
  return (
    config.Memory === memoryBytes &&
    (config.MemorySwap ?? 0) === memoryBytes &&
    (config.NanoCpus ?? 0) === nanoCpus &&
    config.PidsLimit === PIDS_LIMIT &&
    capDrop.includes("all") &&
    capAdd.join(",") === "setgid,setuid" &&
    config.Privileged === false &&
    !config.PidMode &&
    config.IpcMode === "private" &&
    !config.UTSMode &&
    config.ShmSize === SHM_BYTES &&
    (!config.Devices || config.Devices.length === 0) &&
    (!config.DeviceRequests || config.DeviceRequests.length === 0) &&
    !unsafeSecurityOption &&
    !config.UsernsMode &&
    config.CgroupnsMode === "private" &&
    config.OomKillDisable !== true &&
    config.AutoRemove !== true &&
    restartPolicyOk
  );
}

/** Podman normalizes HostConfig capability and namespace fields when it
 * serializes inspect output. Validate its authoritative effective/bounding
 * sets, then normalize only those known representation differences through
 * the unchanged Docker hardening contract. */
export function podmanSecurityIsHardened(
  config: DockerHardeningConfig | undefined,
  effectiveCaps: string[] | undefined,
  boundingCaps: string[] | undefined,
): boolean {
  if (!config) return false;
  const normalizeCaps = (caps: string[] | undefined) => (caps ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  const exactCaps = "setgid,setuid";
  if (normalizeCaps(effectiveCaps).join(",") !== exactCaps) return false;
  if (normalizeCaps(boundingCaps).join(",") !== exactCaps) return false;
  return dockerSecurityIsHardened({
    ...config,
    CapDrop: ["all"],
    CapAdd: effectiveCaps,
    PidMode: config.PidMode === "private" ? "" : config.PidMode,
    UTSMode: config.UTSMode === "private" ? "" : config.UTSMode,
    CgroupnsMode: config.CgroupnsMode || "private",
  });
}

/** Where the well-known host names point inside a managed container.
 *
 *  A documentation-only address (TEST-NET-3, RFC 5737) that no daemon routes
 *  anywhere, so resolving a host name yields nothing to connect to. */
export const HOST_GATEWAY_BLACKHOLE = "203.0.113.1";
const HOST_GATEWAY_NAMES = ["host.docker.internal", "host.containers.internal"] as const;

/** The host-gateway flags for one runtime, and what each one actually buys.
 *
 *  The container needs outbound internet — it browses, installs, and fetches
 *  pages — so `--network none` is never the answer here.  What the runtimes
 *  offer instead is a partial one, and the differences between them are real:
 *
 *  - podman: rootless Podman puts the container behind slirp4netns, whose
 *    `allow_host_loopback` already defaults to false, so a service bound to
 *    the host's 127.0.0.1 is unreachable from inside.  On macOS and Windows
 *    that is the only supported Podman setup (`podman machine`), so the mode
 *    is stated rather than inherited from a default a future runtime version
 *    is free to change.  On Linux the mode is left alone, because rootful
 *    Podman has no slirp4netns and forcing it would stop the VM starting.
 *  - docker / colima: the bridge gateway cannot be removed by a run flag at
 *    all, and Colima runs Docker's engine, so both get the same treatment.
 *    Naming the bridge stops a daemon default from quietly choosing something
 *    else, and the two host names are pinned at a blackhole so the first
 *    thing a container tries does not work.  Reaching the host by its gateway
 *    IP still works on these runtimes; that needs a host firewall rule, which
 *    is a machine-level change outside this repository.
 *  - container: Apple's `container` CLI cannot be verified from this tree, so
 *    it gets no flag it might reject.  It is also the runtime that places
 *    every container in its own lightweight VM, which is the strongest of the
 *    three boundaries already. */
export function containerNetworkArgs(runtime: Runtime, platform: NodeJS.Platform = process.platform): string[] {
  if (runtime === "container") return [];
  const args: string[] = [];
  if (runtime === "podman") {
    if (platform !== "linux") args.push("--network", "slirp4netns:allow_host_loopback=false");
  } else {
    args.push("--network", "bridge");
  }
  for (const host of HOST_GATEWAY_NAMES) args.push("--add-host", `${host}:${HOST_GATEWAY_BLACKHOLE}`);
  return args;
}

/** Common host CLI credential mounts passed read-only into the guest.
 *
 * When enabled, mounts ~/.infisical, ~/.config/infisical, ~/.ssh, ~/.gitconfig,
 * ~/.config/gh, ~/.aws, ~/.config/gcloud, ~/.docker/config.json, ~/.npmrc, etc.
 * into the guest /home/cua directory, so terminal commands run inside the
 * Local VM container inherit the user's CLI authentication. */
export function hostCliCredentialMounts(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string[] {
  if (platform === "win32") return [];
  const mounts: string[] = [];
  for (const candidate of CLI_CREDENTIAL_CANDIDATES) {
    const hostPath = join(home, ...candidate.relPath);
    try {
      if (existsSync(hostPath)) {
        mounts.push("--mount", `type=bind,source=${hostPath},target=${candidate.guest},readonly`);
      }
    } catch {
      // Ignore if unreadable or inaccessible
    }
  }
  return mounts;
}

export function containerRunArgs(
  runtime: Runtime,
  password = "CHANGE_ME",
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
  platform: NodeJS.Platform = process.platform,
  options?: { shareCliCredentials?: boolean; homeDir?: string },
): string[] {
  if (runtime === "container" && target.key !== SHARED_LOCAL_VM_TARGET.key) {
    throw new Error("Per-bot Local VMs require Docker or Podman because Apple container requires a fixed host port");
  }
  const common = ["run", "-d", "--name", target.containerName];
  common.push(
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`,
    "--label",
    `${BASE_IMAGE_LABEL}=${BASE_IMAGE_DIGEST}`,
    "--label",
    `${IMAGE_LAYER_LABEL}=${IMAGE_LAYER_VERSION}`,
    "--label",
    `${WORKSPACE_LABEL}=1`,
    "--label",
    `${TARGET_LABEL}=${target.label}`,
  );
  if (runtime === "container") {
    // Apple container already places each Linux container in a lightweight VM.
    common.push(
      "--memory",
      CONTAINER_MEMORY_ARG,
      "--cpus",
      CONTAINER_CPUS_ARG,
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--shm-size",
      "512m",
    );
  } else {
    common.push(
      "--hostname",
      target.containerName,
      "--memory",
      CONTAINER_MEMORY_ARG,
      "--memory-swap",
      CONTAINER_MEMORY_ARG,
      "--cpus",
      CONTAINER_CPUS_ARG,
      "--pids-limit",
      String(PIDS_LIMIT),
      // Pinned explicitly rather than trusting daemon defaults: the shared
      // hardening check requires private IPC and cgroup namespaces, and a
      // daemon configured with host-mode defaults would otherwise create a
      // container its own acceptance check then rejects.
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
    );
  }
  common.push(...containerNetworkArgs(runtime, platform));
  if (options?.shareCliCredentials) {
    common.push(...hostCliCredentialMounts(platform, options?.homeDir));
  }
  common.push(
    "--mount",
    runtime === "podman"
      ? `type=bind,source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST},relabel=private,U=true`
      : `type=bind,source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST}`,
    "-e",
    `VNC_PW=${password}`,
    "-p",
    target.viewerPort
      ? `127.0.0.1:${target.viewerPort}:${INTERNAL_VIEWER_PORT}`
      : `127.0.0.1::${INTERNAL_VIEWER_PORT}`,
    IMAGE,
  );
  return common;
}

/** Move a pre-move workspace to the new root, once, in place.
 *
 *  `rename` is the whole migration: the files and their inodes move, so a
 *  workspace a container is already bound to keeps its contents, and the run
 *  path that calls this only fires when no container exists for the target —
 *  `containerComputerAction` refuses `run` unless that container is missing.
 *  Nothing is copied and nothing is deleted, so there is no window in which a
 *  workspace exists in two places or in neither.
 *
 *  A rename that cannot happen is reported rather than swallowed: binding the
 *  new empty directory over a workspace that is still at the old path would
 *  present the user with an empty VM and hide their files.  Both directories
 *  are siblings under the same parent, so the realistic failures are a
 *  permissions problem and a bind mount the platform refuses to rename. */
export async function migrateVmWorkspace(
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
  paths: { from?: string; to?: string } = {},
): Promise<string | null> {
  const from = paths.from ?? legacyVmWorkspaceDir(target);
  const to = paths.to ?? target.workspaceDir;
  if (from === to) return null;
  if (!(await stat(from).catch(() => null))?.isDirectory()) return null;
  if (await stat(to).catch(() => null)) return null;
  await mkdir(dirname(to), { recursive: true, mode: 0o700 });
  try {
    await rename(from, to);
  } catch (error) {
    throw new Error(
      `the Local VM workspace at ${from} could not be moved to ${to} — ` +
        `move it by hand, or remove the Local VM and create it again: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return from;
}

async function ensureVmWorkspace(platform: NodeJS.Platform, target: LocalVmTarget): Promise<void> {
  await migrateVmWorkspace(target);
  await mkdir(target.workspaceDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(target.workspaceDir, 0o700);
}

async function prepareManagedImage(runtime: Runtime, runner: CommandRunner): Promise<void> {
  await runner(runtime, ["pull", BASE_IMAGE], 10 * 60_000);
  const context = await mkdtemp(join(tmpdir(), "botfleet-cua-image-"));
  try {
    await writeFile(join(context, "Dockerfile"), managedImageDockerfile(), { mode: 0o600 });
    await runner(runtime, ["build", "-t", IMAGE, context], 10 * 60_000);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

export async function containerComputerAction(
  action: LifecycleAction,
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<ContainerComputerStatus> {
  if (runner === sh && platform === process.platform) screenshotStatusCache.delete(target.key);
  const before = await containerComputerStatus(runner, platform, target);
  const runtime = before.runtime;
  if (!runtime) throw Object.assign(new Error(before.problem ?? "No container runtime is installed"), { status: 409 });
  if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? `${runtime} is not running`), { status: 409 });

  if (action === "run" && before.container !== "missing") {
    throw Object.assign(new Error("A Local VM already exists; remove it before creating a replacement"), { status: 409 });
  }
  if (action === "run" && !before.image) {
    throw Object.assign(new Error("Prepare the Cua desktop image before creating the Local VM"), { status: 409 });
  }
  if (action === "run" && !before.create_supported) {
    throw Object.assign(new Error(before.problem ?? "This runtime cannot create a per-bot Local VM"), { status: 409 });
  }
  if (action === "start") {
    throw Object.assign(new Error("This desktop image cannot safely resume; remove and recreate the Local VM"), {
      status: 409,
    });
  }
  if (action === "stop" && before.container !== "running") {
    throw Object.assign(new Error("The Local VM is not running"), { status: 409 });
  }
  if (action === "remove" && before.container === "missing") return before;

  if (action === "pull") {
    await prepareManagedImage(runtime, runner);
  } else {
    if (action === "run") await ensureVmWorkspace(platform, target);
    let shareCliCredentials = false;
    try {
      shareCliCredentials = Boolean(loadConfig()?.localVm?.shareCliCredentials);
    } catch {
      // Best-effort config read
    }
    const args =
      action === "run"
        ? containerRunArgs(runtime, randomBytes(6).toString("base64url"), target, platform, { shareCliCredentials })
        : action === "remove"
          ? ["rm", runtime === "container" ? "--force" : "-f", target.containerName]
          : [action, target.containerName];
    await runner(runtime, args, 2 * 60_000);
  }
  return containerComputerStatus(runner, platform, target);
}

/** Recreate a stopped Local VM container (the auto-wake), or fail truthfully.
 *
 * Removal is destructive before recreation is constructive, so this runs
 * only when `run` has everything it needs — image, runtime, daemon, and
 * create support — and a partial failure reports what actually happened:
 * after a successful remove the container is GONE, and the pre-wake
 * "stopped" snapshot would misreport that as the current state. Returns
 * the freshest status, so the caller's readiness check never judges a
 * stale snapshot. A non-stopped or unsupported status passes through
 * untouched. */
/** The default Local VM command runner.
 *
 * Exported so a caller that already depends on this module (and only this
 * module) can run an argv without `index.ts` having to reach for
 * `node:child_process` itself, and without `local-vm-shared-session.ts`
 * having to import back into here. */
export const defaultCommandRunner: CommandRunner = sh;

export async function wakeContainerComputer(
  status: ContainerComputerStatus,
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<ContainerComputerStatus> {
  if (
    status.container !== "stopped" ||
    !status.image ||
    !status.runtime ||
    !status.daemonUp ||
    !status.create_supported
  ) {
    return status;
  }
  try {
    await containerComputerAction("remove", runner, platform, target);
    return await containerComputerAction("run", runner, platform, target);
  } catch (error) {
    let fresh = status;
    try {
      fresh = await containerComputerStatus(runner, platform, target);
    } catch {
      // Keep the last known status; the wake error is the truth either way.
    }
    if (fresh.container === "running") return fresh;
    throw new Error(
      `the Local VM could not be restarted: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Cheap capacity probe used by the per-bot pool. It deliberately checks an
 * exact derived container name rather than parsing a broad daemon listing. */
export async function containerComputerExists(
  runtime: Runtime,
  target: LocalVmTarget,
  runner: CommandRunner = sh,
): Promise<boolean> {
  try {
    await runner(runtime, ["inspect", target.containerName], 8_000);
    return true;
  } catch {
    return false;
  }
}

export type ScreenshotCheck = { ok: boolean; mime: "image/png" | "image/jpeg" };

/** Shared with the BYO-VPS backend: a truncated base64 transfer must never
 * become a "successful" preview frame on either transport. */
export function wholeScreenshot(bytes: Buffer): ScreenshotCheck {
  if (bytes.length < 512) return { ok: false, mime: "image/png" };
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (png) {
    return {
      ok: bytes.subarray(Math.max(0, bytes.length - 12)).includes(Buffer.from("IEND", "ascii")),
      mime: "image/png",
    };
  }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return {
    ok: jpeg && bytes.subarray(Math.max(0, bytes.length - 32)).includes(Buffer.from([0xff, 0xd9])),
    mime: "image/jpeg",
  };
}

export async function containerComputerScreenshot(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<string> {
  const cacheable = runner === sh && platform === process.platform;
  const now = Date.now();
  const cached = screenshotStatusCache.get(target.key);
  const status =
    cacheable && cached && cached.expiresAt > now
      ? cached.status
      : await containerComputerStatus(runner, platform, target);
  if (!status.ready || !status.runtime) {
    if (cacheable) screenshotStatusCache.delete(target.key);
    throw Object.assign(new Error(status.problem ?? "The Local VM is not ready"), { status: 409 });
  }
  if (cacheable) screenshotStatusCache.set(target.key, { status, expiresAt: now + SCREENSHOT_STATUS_TTL_MS });
  try {
    const screenshot = target.session?.screenshotPath ?? "/tmp/botfleet-preview.png";
    await runner(
      status.runtime,
      cuaExecArgs([
        "call",
        "get_desktop_state",
        "{}",
        "--socket",
        target.session?.socket ?? CUA_SOCKET,
        "--screenshot-out-file",
        screenshot,
      ], { container: target.containerName, display: target.session?.display }),
      30_000,
    );
    const { stdout } = await runner(
      status.runtime,
      ["exec", target.containerName, "base64", "-w0", screenshot],
      30_000,
    );
    const data = stdout.trim();
    const checked = wholeScreenshot(Buffer.from(data, "base64"));
    if (!checked.ok) {
      throw Object.assign(new Error("Cua Driver returned an incomplete screenshot"), { status: 502 });
    }
    return `data:${checked.mime};base64,${data}`;
  } catch (error) {
    if (cacheable) screenshotStatusCache.delete(target.key);
    throw error;
  }
}

const screenshotStatusCache = new Map<
  string,
  { status: ContainerComputerStatus; expiresAt: number }
>();

const containerMcpPath = SPAWNED_PROXIES.containerMcp;

/** Spawn contract handed directly to agent runtimes. The tiny host wrapper
 * only preserves stdio through the container CLI; Cua Driver owns the MCP
 * protocol and every computer tool. */
type ContainerMcpLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function containerComputerMcp(
  runtime: Runtime,
  control?: { url: string; token: string },
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): ContainerMcpLaunch {
  return {
    command: process.execPath,
    // The socket is per-bot in shared mode: two bots sharing one container must
    // not end up driving the same desktop, so the bridge is told which socket
    // belongs to the bot that owns this turn.
    args: [containerMcpPath, runtime, target.containerName, target.session?.socket ?? CUA_SOCKET],
    // The control pair rides in env, not argv — argv is world-readable
    // through `ps` for the life of the bridge.
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(control ? { OMB_CONTROL_URL: control.url, OMB_CONTROL_TOKEN: control.token } : {}),
    },
  };
}

/** Commands shown as a transparent fallback. Normal setup builds the pinned
 * derivative through the API, so users do not need to author a Dockerfile. */
export function setupCommands(
  runtime: Runtime | null,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
) {
  const install =
    platform === "darwin"
      ? "brew install podman; podman machine init; podman machine start"
      : platform === "win32"
        ? "winget install -e --id RedHat.Podman-Desktop"
        : null;
  const runtimeStart =
    runtime === "container"
      ? "container system start"
      : runtime === "podman" && platform !== "linux"
        ? "podman machine init; podman machine start"
        : runtime === "docker" && platform === "darwin"
          ? "colima start || open -a Docker"
          : runtime === "docker" && platform === "linux"
            ? "sudo systemctl start docker"
            : null;

  if (!runtime) {
    return {
      install,
      runtimeStart: null,
      pull: null,
      run: null,
      start: null,
      stop: null,
      remove: null,
      view: target.viewerPort ? `http://127.0.0.1:${target.viewerPort}/vnc.html` : "",
    };
  }
  const command = (args: string[]) => [runtime, ...args].join(" ");
  return {
    install,
    runtimeStart,
    // This is the inspectable base download. The normal Prepare button also
    // builds the checksum-pinned 0.20.0 derivative automatically.
    pull: command(["pull", BASE_IMAGE]),
    run:
      runtime === "container" && target.key !== SHARED_LOCAL_VM_TARGET.key
        ? null
        : command(containerRunArgs(runtime, "CHANGE_ME", target, platform)),
    start: null,
    stop: command(["stop", target.containerName]),
    remove: command(["rm", runtime === "container" ? "--force" : "-f", target.containerName]),
    view: target.viewerPort ? `http://127.0.0.1:${target.viewerPort}/vnc.html` : "",
  };
}

/* ── Box gateway ───────────────────────────────────────────────────────────
 *
 * The account-wide Box API key used to be handed to the bot's own computer
 * proxy, through that process's environment and the 0600 `mcp.json` the CLI
 * reads.  A bot holding it could list every box in the account, run commands
 * on any of them, and delete any of them — not just the one box its turn had
 * mounted — and it only had to read a file another bot could also read.
 *
 * The key now stays in the harness.  Each mount gets a *grant*: a random
 * bearer that names one box id, and the proxy is pointed at the harness's own
 * loopback gateway instead of ascii.dev.  The gateway re-checks the box id in
 * the path against the grant before it calls the provider, so a proxy that
 * names a box it was not granted is refused here rather than by the provider
 * that would have honoured it.
 */

/** The loopback path the harness serves the gateway on.  Deliberately NOT
 *  under `/api/internal/`, whose routes are gated by the fleet-wide comms
 *  token: a per-mount grant has to be checked here, by this code, and not by
 *  a gate that every bot's proxy already passes. */
export { BOX_GATEWAY_PATH, BOX_GATEWAY_TTL_MS, MAX_BOX_GATEWAY_GRANTS, boxGatewayUrl, mintBoxGatewayGrant } from "./box-gateway-grant.ts";
/** The provider the gateway calls.  Read the harness-side override so a test
 *  rig and a self-hosted deployment address the same base as box.ts does. */
const BOX_GATEWAY_API = process.env.OMB_BOX_API || "https://ascii.dev/api/box/v1";

/** The identity a presented grant names.  How long it stays good for, and how
 *  the token is stored, live in `box-gateway-grant.ts` — a leaf module, so
 *  that `computer-grants.ts` can mint a grant by value without dragging this
 *  file (and `node:path` with it) into the renderer bundle. */
export interface BoxGatewayGrant {
  botId: string;
  boxId: string;
  expiresAt: number;
}

export function revokeBoxGatewayGrant(token: string): void {
  boxGatewayGrants.delete(token);
}

/** Test seam: forget every grant, so one test's mint cannot satisfy another. */
export function resetBoxGatewayGrants(): void {
  boxGatewayGrants.clear();
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Does this grant authenticate this box?  The box id in the path is checked
 *  here and nowhere else, so a proxy cannot widen its own reach by rewriting
 *  the URL it was configured with. */
export function authorizeBoxGateway(
  authorization: string | string[] | undefined,
  boxId: string,
  now = Date.now(),
): { ok: true; grant: BoxGatewayGrant } | { ok: false; status: 401 | 403; error: string } {
  const presented = Array.isArray(authorization) ? "" : String(authorization ?? "").replace(/^Bearer /, "");
  const grant = resolveBoxGatewayGrant(presented, now);
  if (!grant) return { ok: false, status: 401, error: "no live Box grant for this computer" };
  if (grant.boxId !== boxId) {
    return { ok: false, status: 403, error: "this Box grant does not cover that computer" };
  }
  return { ok: true, grant };
}

/** The Box operations a computer proxy is allowed to make, and the methods
 *  each one takes.  Anything not in this table is not proxied at all: the
 *  account key must never become a general-purpose pass-through.
 *
 *  `action` below is read out of the request path and is a general `string`, so
 *  this table genuinely needs an index signature rather than the narrow
 *  literal-keyed type `satisfies` would infer.  An unmapped action reads back
 *  `undefined`, which is exactly the refusal the handler returns.
 */
// oxlint-disable-next-line anti-slop/no-known-value-widening
const BOX_GATEWAY_ACTIONS: Record<string, "GET" | "POST"> = {
  "": "GET",
  commands: "POST",
  resume: "POST",
  files: "GET",
  artifacts: "GET",
};

export interface BoxGatewayRequest {
  method: string;
  /** Path and query, exactly as it arrived. */
  url: string;
  authorization?: string | string[];
  remoteAddress?: string;
  body?: string;
}

export interface BoxGatewayResponse {
  status: number;
  body: string;
}

const json = (status: number, error: string): BoxGatewayResponse => ({ status, body: JSON.stringify({ error }) });

/** Serve one Box call on behalf of a mount's proxy.
 *
 *  The account key is read from the harness config here and nowhere else, and
 *  it is never taken from the request: the child's `authorization` header is
 *  checked against the grant and then dropped. */
export async function handleBoxGatewayRequest(
  request: BoxGatewayRequest,
  // SAFETY: the default is the caller's "no harness config" case, and the
  // gateway reads `cfg.box.token` off it and nothing else — an empty AppConfig
  // yields the same "no account key configured" refusal a partial one would.
  deps: { cfg: AppConfig; fetchImpl?: typeof fetch; now?: number } = { cfg: {} as AppConfig },
): Promise<BoxGatewayResponse> {
  if (!LOOPBACK.has(request.remoteAddress ?? "")) {
    return json(403, "the Box gateway is loopback-only");
  }
  let parsed: URL;
  try {
    parsed = new URL(request.url, "http://127.0.0.1");
  } catch {
    return json(400, "malformed gateway URL");
  }
  if (!parsed.pathname.startsWith(`${BOX_GATEWAY_PATH}/boxes/`)) {
    return json(404, "unknown gateway route");
  }
  const rest = parsed.pathname.slice(`${BOX_GATEWAY_PATH}/boxes/`.length);
  if (rest.includes("/") && rest.split("/").length > 2) return json(404, "unknown gateway route");
  const [boxId = "", action = ""] = rest.split("/");
  // A box id is a provider identifier, never a path fragment.
  if (!/^[\w-]{1,64}$/.test(boxId)) return json(404, "unknown gateway route");
  const allowedMethod = BOX_GATEWAY_ACTIONS[action];
  if (!allowedMethod || request.method.toUpperCase() !== allowedMethod) {
    return json(405, "that Box operation is not proxied");
  }
  const auth = authorizeBoxGateway(request.authorization, boxId, deps.now ?? Date.now());
  if (!auth.ok) return json(auth.status, auth.error);

  const init: RequestInit = {
    method: allowedMethod,
    headers: {
      authorization: `Bearer ${deps.cfg.box?.token ?? ""}`,
      "content-type": "application/json",
    },
  };
  // A GET carries no body at all, and `body: undefined` would send one anyway.
  if (request.body !== undefined) init.body = request.body;
  const upstream = await (deps.fetchImpl ?? fetch)(
    `${BOX_GATEWAY_API}/boxes/${encodeURIComponent(boxId)}/${action}${parsed.search}`,
    init,
  );
  return { status: upstream.status, body: await upstream.text() };
}

/** Cloud boxes still use BotFleet's high-latency REST adapter. Local VMs
 * bypass it and mount Cua Driver's official MCP server through
 * containerComputerMcp().
 *
 * `OGB_BOX_TOKEN` is the mount's gateway grant, never the account-wide Box
 * API key, and `OGB_BOX_API` is the harness's loopback gateway — so a proxy
 * that reads its own environment finds a bearer that authenticates only here,
 * and only for the one box this turn mounted. */
export function computerProxyEnv(
  computer: { boxId?: string; token?: string; gatewayUrl?: string; control?: { url: string; token: string } },
): NodeJS.ProcessEnv {
  // A token with no gateway is the finding all over again: the child would
  // fall back to ascii.dev and present a credential that authorises every box
  // in the account.  Refuse to build the env instead, so a caller that forgets
  // `gatewayUrl` fails here rather than quietly handing over the account key.
  if (computer.token && !computer.gatewayUrl) {
    throw new Error(
      "computerProxyEnv: a Box grant needs a gatewayUrl; refusing to hand a child an ungated Box token",
    );
  }
  const env: NodeJS.ProcessEnv = {
    OGB_BOX_API: computer.gatewayUrl ?? "",
    OGB_BOX_ID: computer.boxId ?? "",
    OGB_BOX_TOKEN: computer.token ?? "",
  };
  if (computer.control) {
    env.OMB_CONTROL_URL = computer.control.url;
    env.OMB_CONTROL_TOKEN = computer.control.token;
  }
  return env;
}

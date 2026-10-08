// Carries the host's GitHub CLI login into the Local VM container.
//
// Why this exists: "Share Host CLI Credentials" bind-mounts `~/.config/gh`
// read-only, but on macOS gh keeps its OAuth token in the Keychain, so the
// mounted `hosts.yml` has no `oauth_token` line at all.  Inside the VM gh was
// installed and signed out, and an https `git push` had no credential.
//
// The fix reuses the existing option rather than adding a setting:
//
//   - At container create, `localVmGhContainerEnv()` points gh at a WRITABLE
//     config directory (the real one is a read-only mount) and points git's
//     github.com credential helper at gh.
//   - After create, and on every Local VM turn, `syncLocalVmGhToken()` reads
//     the host's token with `gh auth token` and logs gh in inside the container
//     with the token on STDIN.  The token never rides on an argv or an `-e`,
//     because argv is world-readable through `ps` and `docker inspect` echoes
//     the environment back.
//
// This module never imports container-computer.ts at runtime (type-only), so
// the import graph stays one-way: container-computer -> this module.
import { createHash } from "node:crypto";

import type { CommandRunner } from "./container-computer.ts";

/** Where gh keeps its config inside the container.  Deliberately NOT under any
 *  bind mount (`~/.config/gh` is a read-only mount of the host's directory),
 *  and under the cua home so it lives exactly as long as the container. */
export const LOCAL_VM_GH_CONFIG_DIR = "/home/cua/.local/state/botfleet-gh";

const GH_HOST = "github.com";
const GUEST_GH_MOUNT = "/home/cua/.config/gh";

/** `gh auth login` validates the token against api.github.com, and the host can
 *  be under heavy load; give it room rather than failing a healthy login. */
const GUEST_LOGIN_TIMEOUT_MS = 60_000;
const HOST_TOKEN_TIMEOUT_MS = 15_000;

/** A token that was rejected is not retried on every turn.  A changed token, or
 *  a recreated container, is retried at once. */
export const GH_SYNC_RETRY_MS = 5 * 60_000;

/** Why git cannot use `gh auth setup-git` here: it writes `~/.gitconfig`, which
 *  is itself a read-only bind mount of the host's file ("Device or resource
 *  busy").  The host file also usually carries the empty `helper =` reset line
 *  that `setup-git` writes, followed by a helper at a macOS path that does not
 *  exist in the container, and a later config file's reset wipes any helper
 *  set in `/etc/gitconfig`.  Git's command-scope environment config
 *  (`GIT_CONFIG_COUNT`, git 2.31+) is read last, so it can reset that list and
 *  put gh's helper in its place without touching any file. */
const GIT_CREDENTIAL_HELPER = "!gh auth git-credential";
const GIT_CREDENTIAL_HOSTS = ["https://github.com", "https://gist.github.com"] as const;

/** The environment `docker run` gives the container so gh and git can use the
 *  login the sync writes.  Every value is non-secret. */
export function localVmGhContainerEnv(): string[] {
  const entries: Array<[string, string]> = [];
  for (const host of GIT_CREDENTIAL_HOSTS) {
    const key = `credential.${host}.helper`;
    // The empty value resets whatever the host's gitconfig set for this URL.
    entries.push([key, ""], [key, GIT_CREDENTIAL_HELPER]);
  }
  return [
    `GH_CONFIG_DIR=${LOCAL_VM_GH_CONFIG_DIR}`,
    `GIT_CONFIG_COUNT=${entries.length}`,
    ...entries.flatMap(([key, value], index) => [`GIT_CONFIG_KEY_${index}=${key}`, `GIT_CONFIG_VALUE_${index}=${value}`]),
  ];
}

/** Host variables that would make `gh auth token` answer with the harness's
 *  own token instead of the signed-in user's login.  Cleared for that one call:
 *  this feature carries the owner's CLI login, not whatever the harness holds. */
const HOST_GH_TOKEN_ENV_OVERRIDES: Record<string, undefined> = {
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
  GH_ENTERPRISE_TOKEN: undefined,
  GITHUB_ENTERPRISE_TOKEN: undefined,
};

/** The host's github.com token, or null when gh is missing, signed out, or the
 *  Keychain refuses.  The value is returned to the caller and goes nowhere
 *  else: it is never logged and never part of an error message. */
export async function readHostGhToken(runner: CommandRunner): Promise<string | null> {
  try {
    const { stdout } = await runner("gh", ["auth", "token", "--hostname", GH_HOST], HOST_TOKEN_TIMEOUT_MS, {
      env: HOST_GH_TOKEN_ENV_OVERRIDES,
    });
    const token = stdout.trim();
    // Printable, no whitespace: anything else is error text, not a token.
    return /^[\x21-\x7e]{8,512}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** The script `docker exec` runs as cua.  Its stdin is the token, which only
 *  the final `gh auth login` reads.  `umask 077` makes every file it creates
 *  owner-only, and the directory is 700, because `--insecure-storage` writes
 *  the token to `hosts.yml` in plaintext (there is no keyring in the VM). */
export function ghLoginScript(): string {
  return [
    "set -eu",
    "umask 077",
    'mkdir -p "$GH_CONFIG_DIR"',
    'chmod 700 "$GH_CONFIG_DIR"',
    // Carry the host's non-secret preferences (git_protocol, editor, aliases)
    // across once.  The token-bearing hosts.yml is deliberately not copied.
    `if [ -f ${GUEST_GH_MOUNT}/config.yml ] && [ ! -e "$GH_CONFIG_DIR/config.yml" ]; then cp ${GUEST_GH_MOUNT}/config.yml "$GH_CONFIG_DIR/config.yml"; fi`,
    `exec gh auth login --hostname ${GH_HOST} --with-token --insecure-storage`,
  ].join("\n");
}

/** argv for the in-container login.  Nothing secret: the token is stdin. */
export function ghLoginExecArgs(containerName: string): string[] {
  return [
    "exec",
    "-i",
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    `GH_CONFIG_DIR=${LOCAL_VM_GH_CONFIG_DIR}`,
    containerName,
    "sh",
    "-c",
    ghLoginScript(),
  ];
}

export type GhSyncOutcome =
  /** Logged in (first time, a changed token, or a recreated container). */
  | "synced"
  /** The container already has this exact token. */
  | "unchanged"
  /** This exact token was rejected recently; not retried yet. */
  | "backoff"
  /** The host has no usable gh login. */
  | "no-host-token"
  /** The in-container login failed. */
  | "failed";

export interface GhSyncDeps {
  runtime: string;
  containerName: string;
  runner: CommandRunner;
  now?: () => number;
  log?: (level: "info" | "warn", message: string) => void;
}

interface SyncEntry {
  hash: string;
  ok: boolean;
  at: number;
}

const entries = new Map<string, SyncEntry>();
const generations = new Map<string, number>();
const inflight = new Map<string, Promise<GhSyncOutcome>>();
const lastLogged = new Map<string, string>();

const defaultLog: NonNullable<GhSyncDeps["log"]> = (level, message) => {
  if (level === "warn") console.warn(message);
  else console.info(message);
};

/** Forget what was written to a container.  Called whenever the container is
 *  created, stopped, or removed: a new container under the same name has no
 *  login, so a remembered hash would otherwise skip the one login it needs. */
export function forgetLocalVmGhToken(containerName: string): void {
  entries.delete(containerName);
  lastLogged.delete(containerName);
  generations.set(containerName, (generations.get(containerName) ?? 0) + 1);
}

export function resetLocalVmGhTokenCache(): void {
  entries.clear();
  generations.clear();
  inflight.clear();
  lastLogged.clear();
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** One non-secret line from a failed command: gh's first stderr line, with the
 *  token scrubbed in case a tool ever echoed it. */
function failureReason(error: unknown, token: string): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr : error instanceof Error ? error.message : "";
  const line = text.split(/\r?\n/).find((entry) => entry.trim()) ?? "command failed";
  return line.split(token).join("<redacted>").slice(0, 200);
}

/** Make the container's gh login match the host's.  Never throws: a missing
 *  gh, a signed-out host, or a failed login only means the VM stays signed out,
 *  and provisioning must not fail over it.
 *
 *  Cheap on the hot path: the host token is read each call (one local exec),
 *  but the container is touched only when a SHA-256 of the token differs from
 *  the one last written there. */
export function syncLocalVmGhToken(deps: GhSyncDeps): Promise<GhSyncOutcome> {
  const generation = generations.get(deps.containerName) ?? 0;
  const flightKey = `${deps.containerName}#${generation}`;
  const existing = inflight.get(flightKey);
  if (existing) return existing;
  const promise = runSync(deps, generation).finally(() => inflight.delete(flightKey));
  inflight.set(flightKey, promise);
  return promise;
}

async function runSync(deps: GhSyncDeps, generation: number): Promise<GhSyncOutcome> {
  const { containerName, runner } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const logOnce = (level: "info" | "warn", message: string) => {
    if (lastLogged.get(containerName) === message) return;
    lastLogged.set(containerName, message);
    log(level, message);
  };
  try {
    const token = await readHostGhToken(runner);
    if (!token) {
      logOnce("info", `[local-vm] ${containerName}: no host gh login to carry in (gh missing or signed out); skipped`);
      return "no-host-token";
    }
    const hash = tokenHash(token);
    const known = entries.get(containerName);
    if (known?.hash === hash) {
      if (known.ok) return "unchanged";
      if (now() - known.at < GH_SYNC_RETRY_MS) return "backoff";
    }
    try {
      // The token is the exec's stdin and nothing else.
      await runner(deps.runtime, ghLoginExecArgs(containerName), GUEST_LOGIN_TIMEOUT_MS, { input: `${token}\n` });
    } catch (error) {
      if ((generations.get(containerName) ?? 0) === generation) {
        entries.set(containerName, { hash, ok: false, at: now() });
      }
      logOnce("warn", `[local-vm] ${containerName}: gh login failed: ${failureReason(error, token)}`);
      return "failed";
    }
    // A container replaced mid-sync is not the one this login went into.
    if ((generations.get(containerName) ?? 0) === generation) {
      entries.set(containerName, { hash, ok: true, at: now() });
    }
    logOnce("info", `[local-vm] ${containerName}: carried the host gh login into the VM`);
    return "synced";
  } catch {
    return "failed";
  }
}

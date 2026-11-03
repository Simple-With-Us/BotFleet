// The fleet's CLI logins, read for one seat and handed to one launched
// child.
//
// The protocol is the fleet's own (AI-Fleet-Coordinator,
// `docs/protocols/cli-login-sync.md`):  a seat's CLI login lives in the
// fleet's project (Fleet-OPS), prod, under `/cli-logins/<SEAT>`, and the
// names inside the folder are the ones the CLIs read out of their
// environment.  The Mac pushes its own login there; nothing is copied
// between hosts, and no value ever reaches this repository, a log line or a
// chat message.
//
// The seat is the one the launch identity carries, so one bot's login goes
// to that bot's launched process and to no other.  A bot with no seat has
// no login: there is no folder to read, and none is invented.
//
// Four rules keep this safe:
//   1. The value goes from the vault into one child's environment and
//      nowhere else:  never into `cfg`, never into `process.env`, never
//      into a log line, an error message or the status view.
//   2. A child never inherits a login from the harness process.  The four
//      names are removed from the child's environment before the seat's own
//      value is put there, so the harness's own `GH_TOKEN` — or another
//      seat's — cannot ride along.  A bot with no seat therefore gets no
//      login at all, rather than somebody else's.
//   3. The folder is read with the machine identity the server already
//      has.  No new credential path is introduced; only the project the
//      request is addressed to changes.
//   4. A read that fails is a read that failed.  The child runs without a
//      login, the turn is not failed over it, and the last good value is
//      kept rather than thrown away.
import { CLI_LOGIN_ENV_NAMES, CLI_LOGIN_FIELDS, cliLoginSecretPath } from "./secret-map.ts";
import { infisical } from "./infisical.ts";
import { applyLaunchIdentity } from "./launch-identity.ts";
import { redactSecretsInText } from "./redact.ts";
import type { LaunchIdentity } from "./contracts.ts";

/** The read a CLI login comes from.
 *
 * A seam, so a test can hand in a stub instead of the live manager.  The
 * project is named, never a credential:  the same machine identity reads
 * every project. */
export interface CliLoginVaultReader {
  /** One folder in the named project.  Rejects when the project is not
   * configured on this host, or when the read fails. */
  readProjectPath(project: "fleet-ops", secretPath: string): Promise<ReadonlyMap<string, string>>;
}

let vault: CliLoginVaultReader = {
  readProjectPath: (project, secretPath) => infisical.readProjectPath(project, secretPath),
};

/** Point this module at a different reader (a test's stub).  Null puts the
 * live manager back. */
export function setCliLoginVault(reader: CliLoginVaultReader | null): void {
  vault = reader ?? { readProjectPath: (project, secretPath) => infisical.readProjectPath(project, secretPath) };
}

/** How long a seat's login is reused before its folder is read again.  The
 * same window the fleet's own reads use for a rotated key. */
export const CLI_LOGIN_TTL_MS = 15 * 60_000;

/** How long a failed read is not tried again.  A vault that is down must not
 * add its timeout to every turn. */
export const CLI_LOGIN_FAILURE_BACKOFF_MS = 60_000;

/** How long a turn waits for the read before it starts without a login.
 * The read itself keeps running in the background, so the value lands in the
 * cache for the next turn rather than being lost. */
export const CLI_LOGIN_READ_WAIT_MS = 5_000;

interface SeatEntry {
  /** The last values read for this seat.  Kept even after a later read
   * fails:  a stale login beats no login. */
  values: Record<string, string>;
  /** When those values were read.  0 when none was ever read. */
  readAt: number;
  /** When the last attempt failed.  0 when the last attempt succeeded. */
  failedAt: number;
}

const cache = new Map<string, SeatEntry>();
const inflight = new Map<string, Promise<Record<string, string>>>();

/** Forget every cached login.  Used by the tests, and by a settings change
 * that turns the vault off. */
export function resetCliLoginCache(): void {
  cache.clear();
  inflight.clear();
}

/** What `afterDelay` resolves to when the wait wins the race.  A distinct
 * sentinel rather than `undefined`, because "the read finished" and "the
 * wait ran out" have to be told apart:  the first hands back a login, the
 * second hands back whatever was known before. */
const WAIT_EXPIRED = Symbol("cli-login.wait-expired");

/** Resolves after `ms`, always — never rejects.  Unref'd so a pending read
 * does not keep the process alive on its own. */
function afterDelay(ms: number): Promise<typeof WAIT_EXPIRED> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(WAIT_EXPIRED), ms);
    timer.unref?.();
  });
}

/** Read the seat's folder and keep only the names the table names.  A row
 * the fleet put there for something else is ignored, and a name the folder
 * does not hold is simply absent. */
async function readSeat(seat: string, secretPath: string): Promise<Record<string, string>> {
  const running = inflight.get(seat);
  if (running) return running;
  const promise = (async () => {
    try {
      const all = await vault.readProjectPath("fleet-ops", secretPath);
      const values: Record<string, string> = {};
      for (const spec of CLI_LOGIN_FIELDS) {
        const value = all.get(spec.env);
        if (value !== undefined && value.length > 0) values[spec.env] = value;
      }
      cache.set(seat, { values, readAt: Date.now(), failedAt: 0 });
      return values;
    } catch (err) {
      // The reason is logged, redacted, and once per failed read — the
      // backoff below is what bounds it.  A login that silently never
      // arrives is the hardest kind of failure to notice, and the vault's
      // own message is already generic.
      const detail = err instanceof Error ? redactSecretsInText(err.message) : "unknown error";
      console.warn(`[cli-login] ${seat}: the seat's CLI login could not be read (${detail}); the child runs without one`);
      const previous = cache.get(seat);
      cache.set(seat, {
        values: previous?.values ?? {},
        readAt: previous?.readAt ?? 0,
        failedAt: Date.now(),
      });
      return previous?.values ?? {};
    }
  })().finally(() => inflight.delete(seat));
  inflight.set(seat, promise);
  return promise;
}

/** The seat's CLI login, as the environment variables a CLI reads.
 *
 * Empty when the seat is not one the fleet's writer could have produced,
 * when the folder holds none of the four names, or when the read failed and
 * nothing was ever read for this seat. */
export async function cliLoginEnvironment(seat: string | null | undefined): Promise<Record<string, string>> {
  const secretPath = seat ? cliLoginSecretPath(seat) : null;
  if (!seat || !secretPath) return {};
  const entry = cache.get(seat);
  const now = Date.now();
  if (entry && now - entry.readAt < CLI_LOGIN_TTL_MS) return entry.values;
  if (entry?.failedAt && now - entry.failedAt < CLI_LOGIN_FAILURE_BACKOFF_MS) return entry.values;

  const read = readSeat(seat, secretPath);
  const settled = await Promise.race([read, afterDelay(CLI_LOGIN_READ_WAIT_MS)]);
  if (settled !== WAIT_EXPIRED) return settled;
  // The read is still running.  The turn goes on without a login rather than
  // waiting on the vault, and the value lands in the cache for the next turn.
  return cache.get(seat)?.values ?? {};
}

/** The driver's own environment with the seat's CLI login applied.
 *
 * The four names are removed first.  A child must never inherit a login
 * from the harness process or from an instance's own environment:  the
 * harness may hold a different seat's `GH_TOKEN`, and a child that
 * inherited it would act as that seat. */
export function applyCliLogins(env: Record<string, string | undefined>, values: Record<string, string>) {
  const out = { ...env };
  for (const name of CLI_LOGIN_ENV_NAMES) delete out[name];
  for (const [name, value] of Object.entries(values)) {
    if (value.length > 0) out[name] = value;
  }
  return out;
}

/** The environment a launched child runs with:  the launch identity applied
 * to the driver's own environment, and the seat's CLI login in it.
 *
 * This is the one call a driver makes instead of `applyLaunchIdentity()` on
 * its own, so a login cannot be forgotten on one engine and added on
 * another.
 *
 * A process that is reused across turns keeps the environment it was
 * spawned with, so a rotated login reaches a new process and not a warm
 * one.  That is the same rule the launch identity already follows. */
export async function launchedChildEnvironment(
  env: Record<string, string | undefined>,
  identity?: LaunchIdentity,
): Promise<Record<string, string | undefined>> {
  const withIdentity = applyLaunchIdentity(env, identity);
  const values = await cliLoginEnvironment(identity?.seat);
  return applyCliLogins(withIdentity, values);
}

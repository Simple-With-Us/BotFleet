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
//   3. The folder is read with its explicitly configured dedicated token
//      source, scoped to this exact project, environment, and folder.
//   4. A read that fails is a read that failed.  The child runs without a
//      login, the turn is not failed over it, and the last good value is
//      kept rather than thrown away.
//
// One shape rule, and it is why the read is not awaited by the drivers:
// every driver claims its thread with a guard and registers the claim a few
// lines later, and that segment has to stay free of `await` — a suspension
// point between the two lets a second turn on the same thread walk through
// the guard the first one already passed.  So the login is resolved from a
// CACHE, synchronously, and the vault read happens in the background.
import { CLI_LOGIN_ENV_NAMES, CLI_LOGIN_FIELDS, cliLoginSecretPath } from "./secret-map.ts";
import { infisical } from "./infisical.ts";
import { applyLaunchIdentity } from "./launch-identity.ts";
import { redactSecretsInText } from "./redact.ts";
import type { LaunchIdentity } from "./contracts.ts";

/** The read a CLI login comes from.
 *
 * A seam, so a test can hand in a stub instead of the live manager.  The
 * project is named, never a credential.
 *
 * A matching source must provide a
 * token for this exact project and folder; it cannot borrow the primary
 * project token or activate machine identity. */
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
 * cost every turn a round trip. */
export const CLI_LOGIN_FAILURE_BACKOFF_MS = 60_000;

/** How many seats' logins are kept at once.
 *
 * The fleet has a dozen seats at most, so this is more than it needs.  The
 * bound exists so a seat string nobody expected cannot grow the map for the
 * life of the process, and the least recently used seat is the one that goes
 * when the map is over it. */
export const CLI_LOGIN_CACHE_MAX = 32;

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
const inflight = new Map<string, Promise<void>>();

/** Bumped by every reset.  A read that started before the bump and lands
 * after it must not write, because a settings change that turns the vault off
 * has to be able to hold. */
let cacheGeneration = 0;

/** Forget every cached login.  Used by the tests, and by a settings change
 * that turns the vault off.
 *
 * A read that was in flight when this is called does not write its value
 * back, so the reset holds. */
export function resetCliLoginCache(): void {
  cacheGeneration++;
  cache.clear();
  inflight.clear();
}

/** The seat's entry, and the seat moved to the most recently used end of the
 * map. */
function readEntry(seat: string): SeatEntry | undefined {
  const entry = cache.get(seat);
  if (entry === undefined) return undefined;
  cache.delete(seat);
  cache.set(seat, entry);
  return entry;
}

/** Keep the seat's entry, and drop the least recently used seat when the map
 * is over its bound.
 *
 * An evicted seat is not remembered, so the next read of it reads it again. */
function writeEntry(seat: string, entry: SeatEntry): void {
  cache.delete(seat);
  cache.set(seat, entry);
  while (cache.size > CLI_LOGIN_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

/** How many seats' logins the cache holds.  The bound is what keeps the map
 * from growing with the seat strings it is handed. */
export function cliLoginCacheSize(): number {
  return cache.size;
}

/** Read the seat's folder and keep only the names the table names.  A row
 * the fleet put there for something else is ignored, and a name the folder
 * does not hold is simply absent.
 *
 * Never rejects:  a failed read is recorded and the last good value stays. */
async function readSeat(seat: string, secretPath: string): Promise<void> {
  const running = inflight.get(seat);
  if (running) return running;
  // The generation is taken before the read starts, so a reset that lands
  // while the read is in flight is visible when the read does.
  const generation = cacheGeneration;
  const promise = (async () => {
    try {
      const all = await vault.readProjectPath("fleet-ops", secretPath);
      const values: Record<string, string> = {};
      for (const spec of CLI_LOGIN_FIELDS) {
        const value = all.get(spec.env);
        if (value !== undefined && value.length > 0) values[spec.env] = value;
      }
      // A reset cleared the cache while this read was in flight, so the
      // login it carries is one the reset meant to drop.
      if (generation !== cacheGeneration) return;
      writeEntry(seat, { values, readAt: Date.now(), failedAt: 0 });
    } catch (err) {
      // The reason is logged, redacted, and once per failed read — the
      // backoff below is what bounds it.  A login that silently never
      // arrives is the hardest kind of failure to notice, and the vault's
      // own message is already generic.
      const detail = err instanceof Error ? redactSecretsInText(err.message) : "unknown error";
      console.warn(`[cli-login] ${seat}: the seat's CLI login could not be read (${detail}); the child runs without one`);
      // The same rule as the read that succeeded:  a reset that landed
      // while this read was in flight means the cache is meant to stay
      // empty, so the failure is not written into it either.
      if (generation !== cacheGeneration) return;
      const previous = cache.get(seat);
      writeEntry(seat, {
        values: previous?.values ?? {},
        readAt: previous?.readAt ?? 0,
        failedAt: Date.now(),
      });
    }
  })().finally(() => {
    // Only this read's own promise is removed, so a reset that cleared the
    // map and a new read that took its place do not lose the new one.
    if (inflight.get(seat) === promise) inflight.delete(seat);
  });
  inflight.set(seat, promise);
  return promise;
}

/** Make sure the seat's CLI login is on its way.
 *
 * A driver calls this at the top of its turn, before it claims the thread,
 * so the background read is already in flight by the time the child is
 * spawned.  Fire and forget:  nothing waits for it, and a failed read is
 * recorded rather than thrown.
 *
 * A seat that is not one the fleet's writer could have produced has no
 * folder, and nothing is read for it. */
export function primeCliLogin(seat: string | null | undefined): void {
  const secretPath = seat ? cliLoginSecretPath(seat) : null;
  if (!seat || !secretPath) return;
  const entry = readEntry(seat);
  const now = Date.now();
  if (entry && now - entry.readAt < CLI_LOGIN_TTL_MS) return;
  if (entry?.failedAt && now - entry.failedAt < CLI_LOGIN_FAILURE_BACKOFF_MS) return;
  void readSeat(seat, secretPath);
}

/** The seat's cached CLI login, as the environment variables a CLI reads.
 *
 * Empty when the seat has none, when the folder holds none of the four
 * names, or when the read has not landed yet.  The read is started by
 * `primeCliLogin()`;  the first turn of a seat after the harness starts may
 * therefore run without the login, and the turns after it have one. */
export function cliLoginEnvironment(seat: string | null | undefined): Record<string, string> {
  if (!seat) return {};
  return readEntry(seat)?.values ?? {};
}

/** Wait for the seat's login read to land, if one is in flight.
 *
 * The drivers do not wait for it —  a turn's child is spawned with
 * whatever the cache holds — but a caller that needs the value now can,
 * and a test needs it to see a read at all. */
export async function awaitCliLogin(seat: string | null | undefined): Promise<void> {
  if (!seat) return;
  await inflight.get(seat);
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
 * The login is handed in rather than read here, and that is deliberate:  a
 * driver reads it BEFORE it claims the thread, because the claim and the
 * registration that follows it have to stay atomic.  A vault read between
 * the two would suspend the driver there, and a second turn on the same
 * thread would walk through the guard that the first one already passed.
 *
 * A process that is reused across turns keeps the environment it was
 * spawned with, so a rotated login reaches a new process and not a warm
 * one.  That is the same rule the launch identity already follows. */
export function launchedChildEnvironment(
  env: Record<string, string | undefined>,
  identity: LaunchIdentity | undefined,
  login: Record<string, string>,
): Record<string, string | undefined> {
  return applyCliLogins(applyLaunchIdentity(env, identity), login);
}

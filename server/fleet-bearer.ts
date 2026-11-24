// The fleet bearer each bot's launched child presents to the fleet's own
// tools.
//
// The fleet's tools (simple-chat, simple-board, recall, simple-git) resolve
// their bearer from `SIMPLE_TOOLS_BEARER` in the environment, and fall back
// to the seat's own private file `~/.secrets/fleet-tools/<seat>`.  The
// hosted gateway decides the seat from the bearer, so a bearer IS an
// identity:  one bot's bearer authenticates that bot and no other.
//
// BotFleet launches every engine child with a scrubbed environment
// (`server/launch-identity.ts` removes every `SIMPLE_TOOLS_*` name), so a
// child inherits nobody's bearer — including the harness's own.  That is the
// correct default, and it leaves a BotFleet bot with no way to use the
// fleet's tools at all.  This module is the other half of that rule:  a
// bearer a bot is entitled to, delivered to that bot and to nobody else.
//
// Five rules keep it safe, and they are the same five `server/cli-logins.ts`
// keeps:
//
//   1. The value goes from the vault into one child's environment and
//      nowhere else:  never into `cfg`, never into `process.env`, never
//      into a log line, an error message, a status view or the renderer.
//   2. A child never inherits a bearer.  The name is removed from the
//      child's environment before the bot's own value is put there, so the
//      harness's own bearer — or another seat's — cannot ride along.  A bot
//      with no bearer therefore gets no bearer, rather than somebody else's.
//   3. The folder is read with its explicitly configured dedicated token
//      source, scoped to this exact project, environment and folder.
//   4. A read that fails is a read that failed.  The child runs without a
//      bearer, the turn is not failed over it, and the last good value is
//      kept rather than thrown away.
//   5. One bot's bearer is one bot's.  The cache is keyed by seat and the
//      read is one folder per seat, so a bearer for one bot cannot
//      authenticate another.
//
// The read is not awaited by the drivers, for the same reason the CLI login
// read is not:  every driver claims its thread with a guard and registers
// the claim a few lines later, and that segment has to stay free of
// `await` — a suspension point between the two lets a second turn on the
// same thread walk through the guard the first one already passed.  So the
// bearer is resolved from a CACHE, synchronously, and the vault read happens
// in the background.

import { FLEET_BEARER_ENV_NAME, fleetBearerSecretPath } from "./secret-map.ts";
import { infisical } from "./infisical.ts";
import { redactSecretsInText } from "./redact.ts";

/** The read a fleet bearer comes from.
 *
 * A seam, so a test can hand in a stub instead of the live manager.  The
 * project is named, never a credential.
 *
 * A matching source must provide a token for this exact project and folder;
 * it cannot borrow the primary project token or activate machine identity. */
export interface FleetBearerVaultReader {
  /** One folder in the named project.  Rejects when the project is not
   * configured on this host, or when the read fails. */
  readProjectPath(project: "fleet-ops", secretPath: string): Promise<ReadonlyMap<string, string>>;
}

let vault: FleetBearerVaultReader = {
  readProjectPath: (project, secretPath) => infisical.readProjectPath(project, secretPath),
};

/** Point this module at a different reader (a test's stub).  Null puts the
 * live manager back. */
export function setFleetBearerVault(reader: FleetBearerVaultReader | null): void {
  vault = reader ?? { readProjectPath: (project, secretPath) => infisical.readProjectPath(project, secretPath) };
}

/** How long a bot's bearer is reused before its folder is read again.  The
 * same window the fleet's own reads use for a rotated key. */
export const FLEET_BEARER_TTL_MS = 15 * 60_000;

/** How long a failed read is not tried again.  A vault that is down must not
 * cost every turn a round trip. */
export const FLEET_BEARER_FAILURE_BACKOFF_MS = 60_000;

/** How long a cached bearer is served after its last successful read.
 *
 * A read that fails keeps the last good value, so a vault that is briefly
 * down does not strip a bot of its tools.  It must not keep it FOREVER,
 * though:  a bearer the owner revoked or rotated has to stop being
 * served, and a value that is older than this window is not served at all
 * until a read succeeds again. */
export const FLEET_BEARER_MAX_STALE_MS = 60 * 60_000;

/** How many bots' bearers are kept at once.
 *
 * The bound exists so a seat string nobody expected cannot grow the map for
 * the life of the process, and the least recently used bot is the one that
 * goes when the map is over it. */
export const FLEET_BEARER_CACHE_MAX = 32;

interface BearerEntry {
  /** The last bearer read for this seat.  Kept even after a later read
   * fails:  a stale bearer beats no bearer. */
  value: string;
  /** When it was read.  0 when none was ever read. */
  readAt: number;
  /** When the last attempt failed.  0 when the last attempt succeeded. */
  failedAt: number;
}

const cache = new Map<string, BearerEntry>();
const inflight = new Map<string, Promise<void>>();

/** Bumped by every reset.  A read that started before the bump and lands
 * after it must not write, because a settings change that turns the vault
 * off has to be able to hold. */
let cacheGeneration = 0;

/** Forget every cached bearer.  Used by the tests, and by a settings change
 * that turns the vault off.
 *
 * A read that was in flight when this is called does not write its value
 * back, so the reset holds. */
export function resetFleetBearerCache(): void {
  cacheGeneration++;
  cache.clear();
  inflight.clear();
  reportedWithoutBearer.clear();
}

/** The seat's entry, and the seat moved to the most recently used end of
 * the map. */
function readEntry(seat: string): BearerEntry | undefined {
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
function writeEntry(seat: string, entry: BearerEntry): void {
  cache.delete(seat);
  cache.set(seat, entry);
  while (cache.size > FLEET_BEARER_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    cache.delete(oldest.value);
  }
}

/** How many bots' bearers the cache holds.  The bound is what keeps the map
 * from growing with the seat strings it is handed. */
export function fleetBearerCacheSize(): number {
  return cache.size;
}

/** Read the seat's folder and keep only the bearer name.  A row the fleet
 * put there for something else is ignored, and a name the folder does not
 * hold is simply absent.
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
      const value = all.get(FLEET_BEARER_ENV_NAME) ?? "";
      // A reset cleared the cache while this read was in flight, so the
      // bearer it carries is one the reset meant to drop.
      if (generation !== cacheGeneration) return;
      writeEntry(seat, { value, readAt: Date.now(), failedAt: 0 });
    } catch (err) {
      // The reason is logged, redacted, and once per failed read — the
      // backoff below is what bounds it.  A bearer that silently never
      // arrives is the hardest kind of failure to notice, and the vault's
      // own message is already generic.
      const detail = err instanceof Error ? redactSecretsInText(err.message) : "unknown error";
      console.warn(`[fleet-bearer] ${seat}: the seat's fleet bearer could not be read (${detail}); the child runs without one`);
      // The same rule as the read that succeeded:  a reset that landed
      // while this read was in flight means the cache is meant to stay
      // empty, so the failure is not written into it either.
      if (generation !== cacheGeneration) return;
      const previous = cache.get(seat);
      writeEntry(seat, {
        value: previous?.value ?? "",
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

/** Make sure the seat's fleet bearer is on its way.
 *
 * A driver calls this at the top of its turn, before it claims the thread,
 * so the background read is already in flight by the time the child is
 * spawned.  Fire and forget:  nothing waits for it, and a failed read is
 * recorded rather than thrown.
 *
 * A seat that is not one the fleet's writer could have produced has no
 * folder, and nothing is read for it. */
export function primeFleetBearer(seat: string | null | undefined): void {
  const secretPath = seat ? fleetBearerSecretPath(seat) : null;
  if (!seat || !secretPath) return;
  const entry = readEntry(seat);
  const now = Date.now();
  if (entry && now - entry.readAt < FLEET_BEARER_TTL_MS) return;
  if (entry?.failedAt && now - entry.failedAt < FLEET_BEARER_FAILURE_BACKOFF_MS) return;
  // The backstop:  a read that throws for a reason the catch inside it
  // does not cover must still be a logged failure and not an unhandled
  // rejection.  Only the message is logged — never the seat's secret.
  void readSeat(seat, secretPath).catch((error: Error) => {
    const detail = redactSecretsInText(error.message);
    console.warn(`[fleet-bearer] the seat's fleet bearer could not be read (${detail}); the child runs without one`);
  });
}

/** The seats already reported as having no bearer, so the report is once
 * per seat and not once per turn.
 *
 * The set is bounded like the cache:  a seat string nobody expected must
 * not grow the map for the life of the process, and the least recently
 * used seat is the one that goes. */
const reportedWithoutBearer = new Set<string>();

/** How many seats' absence may be remembered. */
const REPORTED_WITHOUT_BEARER_MAX = 32;

/** Say that a seat has no bearer, once. */
function noteReportedWithoutBearer(seat: string): void {
  reportedWithoutBearer.delete(seat);
  reportedWithoutBearer.add(seat);
  while (reportedWithoutBearer.size > REPORTED_WITHOUT_BEARER_MAX) {
    const oldest = reportedWithoutBearer.keys().next();
    if (oldest.done) return;
    reportedWithoutBearer.delete(oldest.value);
  }
}

/** The seat's cached fleet bearer, as the environment variable the fleet's
 * tools read.
 *
 * Empty when the seat has none, when the folder holds no bearer name, or
 * when the read has not landed yet.  The read is started by
 * `primeFleetBearer()`;  the first turn of a seat after the harness starts
 * may therefore run without the bearer, and the turns after it have one.
 *
 * A seat with no bearer is REPORTED once, not silently:  a bot that cannot
 * reach the fleet's tools because its bearer was never provisioned is a
 * gap the owner has to see, and a turn is not the place to fail over it —
 * the bot still has every other tool it was given. */
export function fleetBearerEnvironment(seat: string | null | undefined) {
  if (!seat) return {};
  const entry = readEntry(seat);
  if (!entry?.value) {
    // A read that is still in flight is not an absent bearer:  the first
    // turn of a seat would otherwise be reported as a gap that is really
    // only a read that has not come back yet, and the once-only guard
    // would then hide the real report.
    if (!inflight.has(seat)) reportMissingBearer(seat);
    return {};
  }
  // A bearer that is older than the stale window is not served:  the vault
  // has not confirmed it for too long, and a revoked or rotated bearer
  // must stop being used.
  if (Date.now() - entry.readAt > FLEET_BEARER_MAX_STALE_MS) {
    reportMissingBearer(seat);
    return {};
  }
  return { [FLEET_BEARER_ENV_NAME]: entry.value };
}

/** Say once that a seat has no bearer.  The seat is named, because the
 * seat is not a secret;  nothing else is. */
function reportMissingBearer(seat: string): void {
  if (reportedWithoutBearer.has(seat)) return;
  noteReportedWithoutBearer(seat);
  console.warn(
    `[fleet-bearer] ${seat}: no fleet bearer is available, so this seat's fleet tools will not answer; the child runs without one`,
  );
}

/** Wait for the seat's bearer read to land, if one is in flight.
 *
 * The drivers do not wait for it — a turn's child is spawned with whatever
 * the cache holds — but a caller that needs the value now can, and a test
 * needs it to see a read at all. */
export function fleetBearerReadPending(seat: string | null | undefined): boolean {
  if (!seat) return false;
  return inflight.has(seat);
}

export async function awaitFleetBearer(seat: string | null | undefined): Promise<void> {
  if (!seat) return;
  await inflight.get(seat);
}

/** The driver's own environment with the seat's fleet bearer applied.
 *
 * The name is removed first.  A child must never inherit a bearer from the
 * harness process or from an instance's own environment:  the harness may
 * hold a different seat's bearer, and a child that inherited it would act as
 * that seat. */
export function applyFleetBearer(env: Record<string, string | undefined>, values: Record<string, string | undefined>) {
  const out = { ...env };
  delete out[FLEET_BEARER_ENV_NAME];
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && value.length > 0) out[name] = value;
  }
  return out;
}

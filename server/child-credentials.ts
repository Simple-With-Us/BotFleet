// The credentials a launched child gets, and nothing else.
//
// A BotFleet engine child runs with a scrubbed environment:  the launch
// identity replaces whatever the harness process held, and every name that
// could carry another identity is removed.  Two credentials survive that
// scrub on purpose, because they are the seat's own and the child is the
// seat:
//
//   - the seat's CLI logins (the GitHub family), read per seat from the
//     fleet's project by `server/cli-logins.ts`;
//   - the seat's fleet bearer, read per seat the same way by
//     `server/fleet-bearer.ts`, so the child's own fleet tools present it
//     and the hosted gateway names the seat from it.
//
// This module is where they are put together, because the ORDER matters:
// the launch scrub strips every `SIMPLE_TOOLS_*` name, and the bearer's
// name is one of them, so a credential applied before the scrub would be
// removed again.  Both are applied after it.
//
// Nothing else is added.  A child with no seat gets no login and no
// bearer, rather than somebody else's, and a bot whose vault folder holds
// no credential gets none rather than a fallback.

import { applyCliLogins, awaitCliLogin, cliLoginEnvironment, primeCliLogin } from "./cli-logins.ts";
import { applyFleetBearer, awaitFleetBearer, fleetBearerEnvironment, primeFleetBearer } from "./fleet-bearer.ts";
import { applyLaunchIdentity } from "./launch-identity.ts";
import type { LaunchIdentity } from "./contracts.ts";

/**
 * Start the seat's credential reads.
 *
 * A driver calls this at the top of its turn, before it claims the thread:
 * the reads are in flight by the time the child is spawned.  Fire and
 * forget:  nothing waits for them, and a failed read is recorded rather
 * than thrown.
 */
export function primeSeatCredentials(seat: string | null | undefined): void {
  primeCliLogin(seat);
  primeFleetBearer(seat);
}

/**
 * Wait for the seat's credential reads to land.
 *
 * The read is started in the background, so it may still be in flight when
 * the turn reaches the spawn.  A child spawned before the read lands would
 * carry no credential at all, and an engine that keeps a live session would
 * keep carrying none for every later turn — so the spawn waits for the read
 * it started.
 *
 * This is safe where it is called:  it sits BEFORE the turn's guard, so the
 * segment from the guard to the registration stays free of `await` — which
 * is the segment that must be atomic, or a second turn on the same thread
 * would walk through a guard the first one already passed.  Two turns that
 * both wait here still resolve in the order they started, so the first one
 * to resume claims the thread and the second is refused.
 *
 * A read that fails is a failed read, so this never rejects and never fails
 * a turn over a credential that is not there. */
export async function awaitSeatCredentials(seat: string | null | undefined): Promise<void> {
  await awaitCliLogin(seat);
  await awaitFleetBearer(seat);
}

/**
 * The seat's cached credentials, as the environment variables the tools
 * read.
 *
 * The two tables hold disjoint names — the login table's names are the
 * GitHub family and the bearer's name is the fleet's own — so the merge
 * cannot lose one to the other.
 */
export function seatCredentialEnvironment(seat: string | null | undefined) {
  const merged = { ...cliLoginEnvironment(seat) };
  for (const [name, value] of Object.entries(fleetBearerEnvironment(seat))) {
    if (value !== undefined) merged[name] = value;
  }
  return merged;
}

/**
 * The environment a launched child runs with:  the launch identity applied
 * to the driver's own environment, and the seat's credentials in it.
 *
 * The order is the point, and it is the reverse of how it looks:
 *
 *   1. the launch scrub runs first, so no inherited identity — and no
 *      inherited bearer — survives into the child;
 *   2. the seat's CLI login is applied next;
 *   3. the seat's fleet bearer is applied last, because the scrub would
 *      otherwise strip it again.
 *
 * Each apply step removes its own names before it sets them, so a value
 * inherited from the harness process or from an instance's environment
 * cannot ride along, whatever order the steps run in.
 *
 * The credentials are handed in rather than read here, and that is
 * deliberate:  a driver reads them BEFORE it claims the thread, because the
 * claim and the registration that follows it have to stay atomic.  A vault
 * read between the two would suspend the driver there, and a second turn
 * on the same thread would walk through the guard the first one already
 * passed.
 *
 * A process that is reused across turns keeps the environment it was
 * spawned with, so a rotated credential reaches a new process and not a
 * warm one.  That is the same rule the launch identity already follows.
 */
export function launchedChildCredentials(
  env: Record<string, string | undefined>,
  identity: LaunchIdentity | undefined,
  seat: string | null | undefined,
): Record<string, string | undefined> {
  const scrubbed = applyLaunchIdentity(env, identity);
  const withLogin = applyCliLogins(scrubbed, cliLoginEnvironment(seat));
  return applyFleetBearer(withLogin, fleetBearerEnvironment(seat));
}

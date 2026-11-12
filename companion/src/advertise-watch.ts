// Keeps the Bonjour record in step with the network this machine is on.
//
// Advertising used to happen once, at startup, and that failed in both
// directions: a laptop opened before wifi associates has no addresses yet, so
// `advertise` returned false and the sidecar silently never advertised; and a
// DHCP move or network change left the A records pointing at addresses the
// machine no longer holds, so the phone found a computer it could not reach.
// Either way `discovery.advertising` told the panel a story that had stopped
// being true.
//
// The cure is a watcher, not an event: Node has no portable "interfaces
// changed" signal, and a poll every few seconds against the interface table
// costs nothing. Only the *set* of addresses matters — a tick that sees the
// same set does nothing, so re-announcing (which resets caches network-wide)
// happens exactly on transitions.

/** What the watcher needs: the current addresses, and the two moves it can
 * make. It never touches a socket itself, which is what makes it testable. */
export interface AddressWatchOptions {
  /** The addresses worth advertising right now. */
  addresses: () => string[];
  /** How many consecutive ticks a new address set must survive before it is
   * acted on.  Two by default: a VPN or bridge interface that appears and
   * vanishes between ticks would otherwise withdraw, rebind and re-announce
   * the record network-wide every time, which is what filled the log with
   * repeated advertising lines.  The FIRST set is never debounced — a
   * laptop opened before wifi associates has to say something at once. */
  stableTicks?: number;
  /** Rebuild and announce the service record from the current addresses.
   * Resolves false when the responder could not start (port 5353 busy,
   * multicast off) — a condition, never an error. */
  advertise: () => Promise<boolean>;
  /** Withdraw the record and close the responder, so caches forget us rather
   * than pointing phones at addresses we no longer hold. */
  withdraw: () => Promise<void>;
  log?: (line: string) => void;
}

export interface AddressWatcher {
  /** One comparison of the address set against what was last acted on,
   * re-advertising or withdrawing on a change. Exposed for the first run and
   * for tests; the interval calls the same code. */
  check: () => Promise<void>;
  start: (intervalMs?: number) => void;
  stop: () => void;
}

/** How often the interface table is consulted. Reading it is a syscall, not
 * a packet — nothing goes on the wire unless something changed. Networks
 * change on the minutes scale (sleep/wake, wifi hop); this is the sidecar's
 * only recurring wakeup, so it earns a lazy cadence. */
const DEFAULT_INTERVAL_MS = 30_000;

/** How many ticks a change has to hold still before it is worth a rebind. */
const DEFAULT_STABLE_TICKS = 2;

/** Addresses that are real enough to put in an A record a phone on this
 * link will dial.
 *
 * Bonjour is link-scoped: a tunnel address answers a query from a phone that
 * can never route to it, and tunnels are exactly the interfaces that come
 * and go.  So 169.254/16 (DHCP failed) and 100.64/10 (RFC 6598 — Tailscale
 * and friends) are dropped whenever anything else is on offer, and kept when
 * nothing else is, because an unreachable record still beats no record for a
 * phone that is on the same tailnet.
 *
 * Exported so the filter is testable without an interface table. */
export function advertisableSubset(addresses: string[]): string[] {
  const real = addresses.filter((address) => {
    if (address.startsWith("169.254.")) return false;
    const [first, second] = address.split(".").map(Number);
    return !(first === 100 && second >= 64 && second <= 127);
  });
  return real.length > 0 ? real : addresses;
}

export function createAddressWatcher(options: AddressWatchOptions): AddressWatcher {
  // The set last *acted on*, as a canonical key. `null` means "never", which
  // is distinct from "empty": the first check must act — and say so — even on
  // a machine with no network yet, because silence there was the original bug.
  let known: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight = false;
  // The candidate set and how many ticks in a row it has been the answer.
  // A flapping interface never gets to `stableTicks`, so it never costs a
  // rebind; a real move reaches it on the next tick.
  let pending: string | null = null;
  let pendingTicks = 0;
  const stableTicks = Math.max(1, options.stableTicks ?? DEFAULT_STABLE_TICKS);

  const check = async (): Promise<void> => {
    // `advertise` withdraws and rebinds a socket; a tick that lands while one
    // is still doing that must not start a second. The skipped tick loses
    // nothing — the next one sees the same table and acts then.
    if (inflight) return;
    const current = advertisableSubset([...options.addresses()]).sort();
    const key = current.join(",");
    if (key === known) {
      // Back to what is already advertised: whatever was pending was a blip.
      pending = null;
      pendingTicks = 0;
      return;
    }
    // Never debounce the very first answer: silence at startup was the
    // original bug, and there is nothing advertised yet to protect.
    if (known !== null) {
      if (key === pending) pendingTicks += 1;
      else {
        pending = key;
        pendingTicks = 1;
      }
      if (pendingTicks < stableTicks) return;
    }
    pending = null;
    pendingTicks = 0;
    inflight = true;
    try {
      if (current.length === 0) {
        options.log?.("no LAN addresses — advertising paused until a network appears");
        await options.withdraw();
      } else {
        const ok = await options.advertise();
        options.log?.(
          ok
            ? `advertising on ${current.join(", ")}`
            : "could not advertise — pairing by typed address still works",
        );
      }
      // Recorded even when advertising failed: the failure is tied to this
      // network state (port 5353 taken, multicast off), so retrying every
      // five seconds would log the same sentence forever. The next *change*
      // tries again, which is also what heals a responder freed later.
      known = key;
    } catch (error) {
      // An advertise that throws (a malformed record) is logged and not
      // recorded, so it does not read as "advertising" to anyone — but the
      // watcher itself must survive it, or one bad tick ends discovery.
      options.log?.(`advertise failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inflight = false;
    }
  };

  return {
    check,
    start: (intervalMs = DEFAULT_INTERVAL_MS) => {
      if (timer) return;
      timer = setInterval(() => void check(), intervalMs);
      // discovery upkeep must never be what keeps the process alive
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

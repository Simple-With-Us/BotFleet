// The re-advertise contract. What matters is *when* the watcher moves — on a
// change to the address set and never otherwise — because every advertise is
// a socket rebind plus a network-wide announcement, and every missed one is a
// phone holding stale A records. No sockets here: the watcher takes its
// addresses and its two moves as functions, and these tests hand it fakes.
import { describe, expect, it } from "vitest";

import { advertisableSubset, createAddressWatcher, type AddressWatchOptions } from "../src/advertise-watch.ts";

function rig(initial: string[], overrides: Partial<AddressWatchOptions> = {}) {
  let addresses = initial;
  const calls: string[] = [];
  const logs: string[] = [];
  const watcher = createAddressWatcher({
    // These tests are about WHICH transitions move the responder.  The
    // damping — how many ticks a change must hold still first — has its own
    // describe below, and one tick keeps each case here to a single check.
    stableTicks: 1,
    addresses: () => addresses,
    advertise: async () => {
      calls.push(`advertise ${[...addresses].sort().join(",")}`);
      return true;
    },
    withdraw: async () => {
      calls.push("withdraw");
    },
    log: (line) => logs.push(line),
    ...overrides,
  });
  return {
    watcher,
    calls,
    logs,
    set: (next: string[]) => {
      addresses = next;
    },
  };
}

describe("address watcher", () => {
  it("advertises when the network appears after startup", async () => {
    const { watcher, calls, logs, set } = rig([]);
    await watcher.check();
    // The original bug was silence here: no addresses meant no advertise and
    // no record of why. The first check must say so out loud.
    expect(calls).toEqual(["withdraw"]);
    expect(logs.join("\n")).toMatch(/no LAN addresses/);

    set(["192.168.1.42"]);
    await watcher.check();
    expect(calls).toEqual(["withdraw", "advertise 192.168.1.42"]);
  });

  it("does nothing while the address set holds still", async () => {
    const { watcher, calls } = rig(["192.168.1.42"]);
    await watcher.check();
    await watcher.check();
    await watcher.check();
    expect(calls).toEqual(["advertise 192.168.1.42"]);
  });

  it("re-advertises when DHCP moves the machine", async () => {
    const { watcher, calls, set } = rig(["192.168.1.42"]);
    await watcher.check();
    set(["10.0.0.7"]);
    await watcher.check();
    expect(calls).toEqual(["advertise 192.168.1.42", "advertise 10.0.0.7"]);
  });

  it("treats a reordered address list as unchanged", async () => {
    const { watcher, calls, set } = rig(["10.0.0.7", "192.168.1.42"]);
    await watcher.check();
    set(["192.168.1.42", "10.0.0.7"]);
    await watcher.check();
    expect(calls).toHaveLength(1);
  });

  it("withdraws when the last address disappears, and comes back with it", async () => {
    const { watcher, calls, set } = rig(["192.168.1.42"]);
    await watcher.check();
    set([]);
    await watcher.check();
    // withdrawn, not left rotting in caches pointing at a dead address
    expect(calls).toEqual(["advertise 192.168.1.42", "withdraw"]);
    set(["192.168.1.42"]);
    await watcher.check();
    expect(calls).toEqual(["advertise 192.168.1.42", "withdraw", "advertise 192.168.1.42"]);
  });

  it("does not retry a failed advertise until the network changes", async () => {
    const { watcher, calls, logs, set } = rig(["192.168.1.42"], {
      advertise: async () => {
        calls.push("advertise");
        return false;
      },
    });
    await watcher.check();
    await watcher.check();
    // Port 5353 busy is tied to this network state — one attempt per state,
    // or the log repeats the same sentence every five seconds forever.
    expect(calls).toEqual(["advertise"]);
    expect(logs.join("\n")).toMatch(/could not advertise/);
    set(["10.0.0.7"]);
    await watcher.check();
    expect(calls).toEqual(["advertise", "advertise"]);
  });

  it("survives an advertise that throws, and tries again next tick", async () => {
    let attempts = 0;
    const { watcher, calls, logs } = rig(["192.168.1.42"], {
      advertise: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("label longer than 63 bytes");
        calls.push("advertise");
        return true;
      },
    });
    await watcher.check();
    expect(logs.join("\n")).toMatch(/label longer than 63 bytes/);
    // a throw is not recorded as acted-on, so the same set is retried
    await watcher.check();
    expect(calls).toEqual(["advertise"]);
  });

  it("never overlaps a check with one still in flight", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let advertises = 0;
    const { watcher } = rig(["192.168.1.42"], {
      advertise: async () => {
        advertises += 1;
        await gate;
        return true;
      },
    });
    const first = watcher.check();
    // lands while the first advertise is mid-rebind; must not fork a second
    const second = watcher.check();
    release();
    await Promise.all([first, second]);
    expect(advertises).toBe(1);
  });
});

describe("address damping", () => {
  /** The real default: two ticks, no overrides. */
  function damped(initial: string[]) {
    let addresses = initial;
    const calls: string[] = [];
    const watcher = createAddressWatcher({
      addresses: () => addresses,
      advertise: async () => {
        calls.push(`advertise ${[...addresses].sort().join(",")}`);
        return true;
      },
      withdraw: async () => {
        calls.push("withdraw");
      },
    });
    return { watcher, calls, set: (next: string[]) => { addresses = next; } };
  }

  it("acts at once on the first answer, damped or not", async () => {
    const { watcher, calls } = damped(["192.168.1.42"]);
    await watcher.check();
    // Nothing is advertised yet, so there is nothing to protect and silence
    // at startup was the original bug.
    expect(calls).toEqual(["advertise 192.168.1.42"]);
  });

  it("ignores an interface that comes and goes between ticks", async () => {
    // A VPN or bridge interface flapping on a 30s tick used to withdraw,
    // rebind and re-announce the record network-wide every time it moved.
    const { watcher, calls, set } = damped(["192.168.1.42"]);
    await watcher.check();
    set(["192.168.1.42", "192.168.64.1"]);
    await watcher.check();
    set(["192.168.1.42"]);
    await watcher.check();
    set(["192.168.1.42", "192.168.64.1"]);
    await watcher.check();
    set(["192.168.1.42"]);
    await watcher.check();
    expect(calls).toEqual(["advertise 192.168.1.42"]);
  });

  it("acts on a move that holds still for two ticks", async () => {
    const { watcher, calls, set } = damped(["192.168.1.42"]);
    await watcher.check();
    set(["10.0.0.7"]);
    await watcher.check();
    // One tick is not yet a move — it could be the far end of a flap.
    expect(calls).toEqual(["advertise 192.168.1.42"]);
    await watcher.check();
    expect(calls).toEqual(["advertise 192.168.1.42", "advertise 10.0.0.7"]);
    // And having acted, it stays quiet.
    await watcher.check();
    await watcher.check();
    expect(calls).toHaveLength(2);
  });
});

describe("advertisableSubset", () => {
  it("keeps the addresses a phone on this link can actually dial", () => {
    expect(advertisableSubset(["192.168.1.42", "100.101.102.103", "169.254.1.1"])).toEqual(["192.168.1.42"]);
  });

  it("keeps a tunnel address when it is the only one there is", () => {
    // Bonjour is link-scoped, so a tailnet address in an A record is close
    // to useless — but "close to useless" beats "no record at all" for a
    // phone that is on the same tailnet and nothing else.
    expect(advertisableSubset(["100.101.102.103"])).toEqual(["100.101.102.103"]);
    expect(advertisableSubset(["169.254.1.1"])).toEqual(["169.254.1.1"]);
    expect(advertisableSubset([])).toEqual([]);
  });

  it("does not mistake a real 100.x LAN address for CGNAT", () => {
    // 100.64/10 is the reserved range; 100.0.x and 100.200.x are ordinary.
    expect(advertisableSubset(["100.0.0.5", "100.200.0.5"])).toEqual(["100.0.0.5", "100.200.0.5"]);
  });
});

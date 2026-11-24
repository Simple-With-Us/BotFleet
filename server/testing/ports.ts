// Picking ports for a suite that boots real servers.
//
// A random port in a wide range is fine until two suites run at once — the
// second one loses a bind it never checked, and the failure surfaces as
// whatever the server does when it cannot listen, which is rarely "port
// taken". Probing first turns that into a port nobody else holds.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { mcpOAuthRedirectUri } from "../mcp-oauth.ts";

/** Bind a port, then let it go. False when something already has it. */
const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

/**
 * The pool the suite takes its ports from.
 *
 * It sits below the kernel's ephemeral range, so the OS never hands one of
 * these ports to an outgoing connection: a port inside that range can be
 * taken between the pick and the bind, and the suite then fails on
 * EADDRINUSE instead of on anything it asserts.
 */
export const PORT_POOL_START = 19_600;

/**
 * How many bands the pool is cut into, and how wide a band is.
 *
 * A band is one process's share of the pool.  Two suites that run at the
 * same time are two processes, so two bands, so they cannot pick the same
 * base — which a single shared range could not promise, because the probe
 * releases the port before the caller binds it.
 */
export const PORT_POOL_BANDS = 128;
export const PORT_POOL_BAND_WIDTH = 24;

/** The last port of the pool, exclusive. */
export const PORT_POOL_END = PORT_POOL_START + PORT_POOL_BANDS * PORT_POOL_BAND_WIDTH;

/** The slice of the pool one process may take ports from. */
export type PortBand = {
  /** The first port of the band. */
  start: number;
  /** The last port of the band, exclusive. */
  end: number;
};

/**
 * The band of the pool a process may take ports from.
 *
 * The process id picks the band.  Workers are spawned in a burst, so the
 * workers running at the same moment have neighbouring ids and therefore
 * neighbouring bands; a band is far wider than the two or three ports one
 * suite asks for, and two suites in the same worker run one after the
 * other, where the probe alone is enough.
 */
export function portBand(pid: number = process.pid): PortBand {
  const band = ((pid % PORT_POOL_BANDS) + PORT_POOL_BANDS) % PORT_POOL_BANDS;
  const start = PORT_POOL_START + band * PORT_POOL_BAND_WIDTH;
  return { start, end: start + PORT_POOL_BAND_WIDTH };
}

/** The bases a block of offsets may take inside a band. */
export type PortBlockBases = {
  /** The first base the block may take. */
  first: number;
  /** The last base the block may take. */
  last: number;
};

/**
 * The bases a block of these offsets may take inside the band.
 *
 * The block has to fit WHOLE:  a base near the end of the band would put
 * `base + offset` into the next band, which belongs to another suite, and
 * the partition that keeps two suites apart would be undone by one port.
 * So the base is bounded by the widest offset on both sides, and a block
 * that does not fit the band is refused rather than spilling.
 */
export function portBlockBases(
  band: PortBand,
  offsets: number[],
): PortBlockBases {
  const lowest = offsets.length === 0 ? 0 : Math.min(...offsets);
  const highest = offsets.length === 0 ? 0 : Math.max(...offsets);
  return {
    first: band.start - lowest,
    last: band.end - 1 - highest,
  };
}

/**
 * The bases a block may take inside the band, in the order they are tried.
 *
 * Every base is tried exactly once:  a draw with replacement can miss the
 * one free base that is left, and then the suite throws although a free
 * block was there the whole time.  The order is shuffled so two suites in
 * the same band do not both reach for the same base first.
 */
export function portBlockOrder(band: PortBand, offsets: number[]): number[] {
  const bases = portBlockBases(band, offsets);
  if (bases.last < bases.first) {
    throw new Error(
      `a block of offsets ${offsets.join(",")} does not fit in a band of ${PORT_POOL_BAND_WIDTH} ports`,
    );
  }
  const order: number[] = [];
  for (let base = bases.first; base <= bases.last; base += 1) order.push(base);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    const held = order[index];
    order[index] = order[swap];
    order[swap] = held;
  }
  return order;
}

/**
 * Find a base port where every `base + offset` is free.
 *
 * Offsets rather than a count because the ports a suite needs are rarely
 * contiguous: the harness quietly opens a webhook receiver one above itself,
 * and a sidecar sits well clear of both. Asking for the exact set is the only
 * way to know the whole layout is clear.
 *
 * This is a probe, not a reservation — the ports are released before they are
 * returned, so a third party can still take one in the gap.  The band keeps
 * that gap away from the suites running at the same time, and the probe
 * covers everything else.
 */
export async function freePortBlock(offsets: number[]): Promise<number> {
  const band = portBand();
  for (const base of portBlockOrder(band, offsets)) {
    const checks = await Promise.all(offsets.map((offset) => isFree(base + offset)));
    if (checks.every(Boolean)) return base;
  }
  throw new Error(
    `no free port block for offsets ${offsets.join(",")} in ${band.start}..${band.end}`,
  );
}

function ephemeralFloor(): number {
  try {
    return Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 49_152;
  } catch {
    return 49_152;
  }
}

/** MCP OAuth redirect port that stays below the kernel ephemeral range. */
export async function withFreeSignInPort(url: string): Promise<string> {
  const floor = ephemeralFloor();
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = new URL(url);
    candidate.searchParams.set("app", String(attempt));
    const port = Number(new URL(mcpOAuthRedirectUri(candidate.toString())).port);
    if (port < floor && await isFree(port)) return candidate.toString();
  }
  throw new Error(`no free sign-in redirect port below ${floor} for ${url}`);
}

// The pool the suite takes its ports from:  where it sits, and the band each
// process gets out of it.
//
// The bounds matter as much as the partition.  A port inside the kernel's
// ephemeral range can be handed to an outgoing connection between the pick
// and the bind, and the suite then fails on EADDRINUSE instead of on
// anything it asserts.  The partition matters because two suites running at
// the same time are two processes: they must not be able to pick the same
// base out of one shared range.
import { describe, expect, it } from "vitest";

import {
  PORT_POOL_BANDS,
  PORT_POOL_BAND_WIDTH,
  PORT_POOL_END,
  PORT_POOL_START,
  portBand,
} from "./ports.ts";

/** The lowest ephemeral port the kernel hands out on the CI runners. */
const LOWEST_EPHEMERAL_PORT = 32_768;

describe("the free-port pool", () => {
  it("keeps the whole pool below the kernel's ephemeral range", () => {
    expect(PORT_POOL_START).toBeGreaterThan(1_024);
    expect(PORT_POOL_END).toBeLessThan(LOWEST_EPHEMERAL_PORT);
  });

  it("cuts the pool into bands that cover it exactly, with no gap and no overlap", () => {
    const bands = Array.from({ length: PORT_POOL_BANDS }, (_, index) => portBand(index));
    expect(bands[0].start).toBe(PORT_POOL_START);
    for (let index = 1; index < bands.length; index += 1) {
      expect(bands[index].start).toBe(bands[index - 1].end);
    }
    expect(bands[bands.length - 1].end).toBe(PORT_POOL_END);
  });

  it("gives workers running at the same moment bands of their own", () => {
    // Workers are spawned in a burst, so the ones alive together have
    // neighbouring process ids.  Their bands must not overlap, or two
    // suites could pick the same base.
    const starts = new Set<number>();
    for (let pid = 1; pid <= 64; pid += 1) starts.add(portBand(pid).start);
    expect(starts.size).toBe(64);
  });

  it("gives a band room for the ports one suite asks for", () => {
    // The widest block a suite asks for is the harness and the webhook
    // receiver it opens one above itself.
    expect(PORT_POOL_BAND_WIDTH).toBeGreaterThanOrEqual(2);
    for (let pid = 0; pid < PORT_POOL_BANDS; pid += 1) {
      const band = portBand(pid);
      expect(band.end - band.start).toBe(PORT_POOL_BAND_WIDTH);
    }
  });

  it("keeps a negative process id inside the pool", () => {
    const band = portBand(-1);
    expect(band.start).toBeGreaterThanOrEqual(PORT_POOL_START);
    expect(band.end).toBeLessThanOrEqual(PORT_POOL_END);
  });
});

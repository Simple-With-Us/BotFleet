import { describe, expect, it } from "vitest";

import { FailureLogDedup } from "./log-dedup.ts";

function harness(now?: () => number) {
  const lines: string[] = [];
  const dedup = new FailureLogDedup({
    summaryIntervalMs: 1_000,
    log: (message) => lines.push(message),
    formatSummary: (count, since, last) => `${count} failed since ${since} (last: ${last})`,
    // `now` is optional on FailureLogDedupOptions and defaults internally
    // (`options.now ?? Date.now`), so passing it through unconditionally —
    // `undefined` when the caller omitted it — is equivalent to a
    // conditional spread without hiding the omission behind `{}`.
    now,
  });
  return { dedup, lines };
}

describe("FailureLogDedup", () => {
  it("logs the first occurrence of a kind immediately", () => {
    const { dedup, lines } = harness();
    dedup.report("http-503", "HTTP 503");
    expect(lines).toEqual(["HTTP 503"]);
  });

  it("collapses repeats of the same kind until the summary window elapses", () => {
    let now = 0;
    const { dedup, lines } = harness(() => now);
    dedup.report("http-503", "HTTP 503");
    now += 100;
    dedup.report("http-503", "HTTP 503");
    now += 100;
    dedup.report("http-503", "HTTP 503");
    expect(lines).toEqual(["HTTP 503"]);

    now += 1_000;
    dedup.report("http-503", "HTTP 503");
    expect(lines).toHaveLength(2);
    // 3 repeats beyond the first, individually-logged occurrence — not 4:
    // that one already has its own line above, so counting it again in the
    // summary would over-report by one.
    expect(lines[1]).toMatch(/^3 failed since \d{2}:\d{2} \(last: HTTP 503\)$/);
  });

  it("logs immediately when the failure kind changes mid-window", () => {
    const { dedup, lines } = harness();
    dedup.report("http-503", "HTTP 503");
    dedup.report("http-500", "HTTP 500");
    expect(lines).toEqual(["HTTP 503", "HTTP 500"]);
  });

  it("flushes a pending summary before logging a changed kind", () => {
    let now = 0;
    const { dedup, lines } = harness(() => now);
    dedup.report("http-503", "HTTP 503");
    now += 50;
    dedup.report("http-503", "HTTP 503");
    dedup.report("http-500", "HTTP 500");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("HTTP 503");
    expect(lines[1]).toMatch(/^1 failed since \d{2}:\d{2} \(last: HTTP 503\)$/);
    expect(lines[2]).toBe("HTTP 500");
  });

  it("reset() flushes a pending summary and starts fresh", () => {
    let now = 0;
    const { dedup, lines } = harness(() => now);
    dedup.report("http-503", "HTTP 503");
    now += 50;
    dedup.report("http-503", "HTTP 503");
    dedup.reset();
    expect(lines).toHaveLength(2);

    dedup.report("http-503", "HTTP 503");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("HTTP 503");
  });

  it("clear() drops a pending count without printing it", () => {
    let now = 0;
    const { dedup, lines } = harness(() => now);
    dedup.report("http-503", "HTTP 503");
    now += 50;
    dedup.report("http-503", "HTTP 503");
    dedup.clear();
    expect(lines).toHaveLength(1);

    dedup.report("http-503", "HTTP 503");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("HTTP 503");
  });
});

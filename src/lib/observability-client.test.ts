// The Observability card's two calls to the harness.
//
// The failure these guard is quiet rather than loud: a bare
// `fetch("/api/observability").then(r => r.json())` parses a 404 or a 403
// error body just as happily as a status view, so a harness that predates
// the route — or a request the loopback gate refused — used to land as "no
// status and no error" and leave the pill on "Waiting" for good.  Going
// through the store's `api()` helper is what turns those into a message the
// operator can read, and what retries the 502 a harness briefly answers
// while it restarts — the exact moment this card is most likely open.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchObservabilityStatus, sendObservabilityTestEvent } from "./observability-client";

type StubbedResponse = { status: number; body: unknown };

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string }> = [];

/** Answer each call in turn with the next scripted response; the last one
 * repeats, so a retry sees it too. */
function stubFetch(responses: StubbedResponse[]): void {
  let index = 0;
  // SAFETY: the whole stub narrows to `fetch` because `api()` is the only
  // caller and it reaches for exactly four members of the response.
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase() });
    const scripted = responses[Math.min(index, responses.length - 1)];
    index += 1;
    // SAFETY: `ok`, `status`, `statusText` and `json()` are every member
    // `api()` touches; a fuller Response would be scaffolding the code under
    // test never reads.
    return {
      ok: scripted.status >= 200 && scripted.status < 300,
      status: scripted.status,
      statusText: `status ${scripted.status}`,
      json: async () => scripted.body,
    } as Response;
  }) as typeof globalThis.fetch;
  globalThis.fetch = stub;
}

const STATUS_BODY = {
  enabled: true,
  configured: true,
  source: "config",
  host: "o0.ingest.sentry.io",
  projectId: "1",
  environment: "production",
  tracesSampleRate: 0.2,
  logsEnabled: true,
  profilingAvailable: false,
  totalCaptured: 3,
  lastEventAt: "2026-09-08T00:00:00.000Z",
  lastError: null,
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("fetchObservabilityStatus", () => {
  it("returns the harness's status view", async () => {
    stubFetch([{ status: 200, body: STATUS_BODY }]);

    await expect(fetchObservabilityStatus()).resolves.toMatchObject({
      enabled: true,
      source: "config",
      host: "o0.ingest.sentry.io",
    });
    expect(calls).toEqual([{ url: "/api/observability", method: "GET" }]);
  });

  // A harness too old for this route answers 404 with a perfectly parseable
  // error body.  Reading that as "no status" is what pins the pill on
  // "Waiting" with nothing to explain it.
  it("surfaces a 404 from an older harness instead of reading as no status", async () => {
    stubFetch([{ status: 404, body: { error: "not found" } }]);

    await expect(fetchObservabilityStatus()).rejects.toThrow("not found");
  });

  it("surfaces the loopback gate's refusal", async () => {
    stubFetch([{ status: 403, body: { error: "loopback only" } }]);

    await expect(fetchObservabilityStatus()).rejects.toThrow("loopback only");
  });

  // A restarting harness answers 502 for a moment.  The card is most likely
  // to be open at exactly that moment, because saving a DSN is what set the
  // restart off.
  it("retries the 502 a restarting harness returns", async () => {
    stubFetch([
      { status: 502, body: { error: "bad gateway" } },
      { status: 200, body: STATUS_BODY },
    ]);

    await expect(fetchObservabilityStatus()).resolves.toMatchObject({ source: "config" });
    expect(calls).toHaveLength(2);
  });

  it("reads a body that is not a status view as no status at all", async () => {
    stubFetch([{ status: 200, body: { ok: true } }]);

    await expect(fetchObservabilityStatus()).resolves.toBeNull();
  });
});

describe("sendObservabilityTestEvent", () => {
  it("reports the event id the harness answered with", async () => {
    stubFetch([{ status: 200, body: { ok: true, error: null, eventId: "evt_1" } }]);

    await expect(sendObservabilityTestEvent()).resolves.toEqual({
      ok: true,
      error: null,
      eventId: "evt_1",
    });
    expect(calls).toEqual([{ url: "/api/observability/test", method: "POST" }]);
  });

  // A 500 whose body carries the server's own wording must reach the card as
  // that wording, not as the card's generic fallback.
  it("surfaces the server's message on a failed POST", async () => {
    stubFetch([{ status: 500, body: { error: "Sentry is not running on this computer." } }]);

    await expect(sendObservabilityTestEvent()).rejects.toThrow("Sentry is not running on this computer.");
  });

  it("does not retry a POST", async () => {
    stubFetch([{ status: 502, body: { error: "bad gateway" } }]);

    await expect(sendObservabilityTestEvent()).rejects.toThrow("bad gateway");
    expect(calls).toHaveLength(1);
  });

  it("treats a 2xx that reports failure as a failure, keeping the reason", async () => {
    stubFetch([{ status: 200, body: { ok: false, error: "Set a Sentry DSN first.", eventId: null } }]);

    await expect(sendObservabilityTestEvent()).resolves.toEqual({
      ok: false,
      error: "Set a Sentry DSN first.",
      eventId: null,
    });
  });
});

// The card is a .tsx component and this suite is node-only, so the one thing
// a behavioural test cannot reach is whether the card still calls these
// helpers.  Guard it by reading the source: a reintroduced bare `fetch` is
// exactly the regression above, and it is silent.
describe("the Observability card's transport", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const card = readFileSync(join(ROOT, "src/components/ObservabilitySection.tsx"), "utf8");

  it("goes through the store helper, never a bare fetch", () => {
    expect(card).toContain("fetchObservabilityStatus");
    expect(card).toContain("sendObservabilityTestEvent");
    expect(card).not.toMatch(/\bfetch\s*\(/);
  });
});

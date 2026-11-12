/** The two calls the Observability card makes to the harness, routed through
 * the store's `api()` helper rather than a bare `fetch`.
 *
 * `api()` is the difference between a card that tells the truth and one that
 * sits on "Waiting" forever.  It checks `res.ok`, so a 404 from a harness
 * that predates these routes and a 403 from the loopback gate both arrive
 * here as thrown errors instead of parsing cleanly into a body with no
 * `source` field; and it retries a 502 once, which is what a harness briefly
 * returns while it restarts — the exact moment this card is most likely to
 * be open.  A bare `fetch(...).then(r => r.json())` silently discards both.
 */
import { api } from "@/state/store";

import type { ObservabilityStatusView } from "./observability-status";

/** What `POST /api/observability/test` reports back, normalised.  `ok` is
 * never inferred from the transport: a 2xx whose body says the event was
 * refused is still a failure, and the server's own wording is kept. */
export type ObservabilityTestEventResult = {
  ok: boolean;
  error: string | null;
  eventId: string | null;
};

/** What `POST /api/observability/test` answers with.  Every field is
 * optional because an older harness, or a body that never parsed, leaves the
 * object empty and the caller falls back to its own copy. */
type TestEventResponse = {
  ok?: boolean;
  error?: string | null;
  eventId?: string | null;
};

/** The harness's current diagnostics status, or null when the response is
 * not one.  A harness too old for this route answers something that is not a
 * status view; anything without `source` reads as no status at all rather
 * than a half-filled card.  Throws whatever `api()` throws — the caller is
 * expected to show that message, not swallow it. */
export async function fetchObservabilityStatus(): Promise<ObservabilityStatusView | null> {
  const body: ObservabilityStatusView | null = await api("/api/observability");
  return body && Object.hasOwn(body, "source") ? body : null;
}

/** Ask the harness to send one real event to the configured project.  Throws
 * on a transport or HTTP failure so the card can show the server's message;
 * a body that reports `ok: false` comes back as a result, not a throw. */
export async function sendObservabilityTestEvent(): Promise<ObservabilityTestEventResult> {
  const data: TestEventResponse | null = await api("/api/observability/test", { method: "POST" });
  const ok = data?.ok === true;
  return {
    ok,
    error: ok ? null : data?.error || "Sentry did not accept the test event.",
    eventId: data?.eventId ?? null,
  };
}

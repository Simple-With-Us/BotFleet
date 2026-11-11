// Native (un-normalized) protocol tee — the debugging trick from upstream's
// EventNdjsonLogger and agentcal's onRaw: every provider-native message is
// written verbatim next to the canonical stream, so protocol drift can be
// diagnosed by diffing the two.
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { BoundedAppendQueue, type AppendQueueStats } from "../harness/append-queue.ts";
import { redactSecretsForLog } from "../redact.ts";
import { appendBoundedAsync, NATIVE_LOG_MAX_BYTES } from "../transcript-retention.ts";

// Every driver calls `appendNative` on its hot path — once per stdout line
// for the ACP engines, once per model round for the HTTP lane — and the msg
// it carries can be a whole file a tool just read.  The tee used to redact
// that msg uncapped and append it with `appendFileSync`, on the harness's
// only thread, so one multi-megabyte tool result stalled every other bot's
// turn, the SSE fan-out and `/api/health` behind it.  It now takes the same
// path the canonical event tee in server/harness/bus.ts does: the capped
// log-redaction pass, then ONE bounded FIFO drained by one in-flight async
// write.  One queue for every thread keeps records in publish order per
// file (and across files), which the rotation bookkeeping in
// `appendBoundedAsync` requires.
const writes = new BoundedAppendQueue<null>(
  (file, data) => appendBoundedAsync(file, data, NATIVE_LOG_MAX_BYTES, { mode: 0o600 }),
  // Named, so a drop line for this tee cannot be mistaken for one from the
  // canonical event log's queue in server/harness/bus.ts.
  { label: "native protocol tee" },
);

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  try {
    // The session-setup messages carry the credentials the agent is handed —
    // the box and comms tokens ride inside session/new's mcpServers env, and
    // an MCP header can carry a Composio key. These files are ordinary
    // 0644 files people paste into bug reports, so values are masked while
    // the shape stays intact.  `redactSecretsForLog` masks exactly what
    // `redactSecrets` does and then caps each string, so the cost of one
    // record is bounded by the cap rather than by the size of the payload.
    // Bounded, not unbounded: the tee rotates at NATIVE_LOG_MAX_BYTES rather
    // than growing to the gigabytes it reached before
    // server/transcript-retention.ts existed.
    writes.enqueue(
      join(NATIVE_DIR, `${threadId}.ndjson`),
      JSON.stringify({ at: new Date().toISOString(), ...entry, msg: redactSecretsForLog(entry.msg) }) + "\n",
      null,
    );
  } catch {
    /* never let logging break a run */
  }
}

/** Resolves once every record queued so far has been written or dropped.
 *  For shutdown and for tests that read the log back. */
export function flushNativeTee(): Promise<void> {
  return writes.flush();
}

/** The tee queue's backlog and drop counters. */
export function nativeTeeStats(): AppendQueueStats {
  return writes.stats();
}

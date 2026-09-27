// Bound the prior turns a transcript-replay driver sends back to the
// provider each round.
//
// WHY THIS FILE EXISTS.  MiniMax, Grok, and the OpenAI-compat drivers all
// fold the full thread transcript into every chat-completions request, so
// a long conversation can grow past 1M prompt tokens — and because every
// round's prefix is byte-identical to the prior round's prefix to keep
// the endpoint's prompt cache reachable, that oversized prefix is
// re-uploaded on every tool call too.  The Codex review flagged this as
// the largest replay-driven token cost in the driver layer, alongside the
// tool-output caps applied separately to MCP results.
//
// The cap keeps the most recent entries (so the latest tool call and its
// result stay paired) and drops the oldest ones.  Pair preservation is
// why we walk from the back rather than from the front: dropping the
// front would leave the most recent `assistant` tool_calls unbacked by a
// `tool` role result and force the model to re-call.
//
// The byte budget is the dominant bound — long messages can each be tens
// of KB — and the entry-count budget is the secondary bound so a thread
// of short messages still cannot ship 1,000 turns.

import type { SendTurnInput } from "../../contracts.ts";

type Transcript = NonNullable<SendTurnInput["transcript"]>;

export interface ReplayCap {
  /** Maximum bytes the kept transcript may total, measured as UTF-8 of
   *  every text + tool-call argument + tool-result payload.  Default is
   *  200 KiB; raise for models with very long system prompts, lower for
   *  cost-sensitive bots. */
  maxBytes?: number;
  /** Maximum number of transcript entries the helper will keep, on top
   *  of the byte budget.  Default is 60 — well above any realistic
   *  context window for short turns, well below the hundreds of turns a
   *  bug elsewhere could otherwise queue up. */
  maxEntries?: number;
}

/** Default cap shared by every chat-completions driver.  Both bounds are
 *  inclusive ceilings — the helper never returns a transcript whose
 *  totals exceed them. */
export const DEFAULT_REPLAY_CAP: Required<ReplayCap> = {
  maxBytes: 200 * 1024,
  maxEntries: 60,
};

/** Return a prefix of `transcript` whose byte cost fits inside
 *  `cap.maxBytes` and whose entry count fits inside `cap.maxEntries`,
 *  preserving the most recent entries so a tool-call / tool-result pair
 *  at the tail stays together.  An empty or missing transcript returns
 *  an empty array — never a reference to the caller's array, so callers
 *  can mutate the result without surprising the harness.
 *
 *  The byte estimate uses UTF-8 byte length so multibyte text is
 *  accounted for at the same rate the provider's tokenizer will see it
 *  (a 4-byte emoji costs 4 bytes here, not 1 length unit). */
export function capReplayedTranscript(
  transcript: Transcript | undefined,
  cap: ReplayCap = {},
): Transcript {
  const maxBytes = cap.maxBytes ?? DEFAULT_REPLAY_CAP.maxBytes;
  const maxEntries = cap.maxEntries ?? DEFAULT_REPLAY_CAP.maxEntries;
  if (!transcript || transcript.length === 0) return [];

  let bytes = 0;
  let entries = 0;
  // The transcript entry most recently kept by the walk — needed so we
  // can recognize when the *next* older entry is its tool-call partner
  // and must be kept with it even if doing so overflows the byte cap.
  let lastKept: Transcript[number] | null = null;
  // Index of the OLDEST transcript entry the helper keeps.  Starts at 0
  // (keep everything) and walks forward as we drop older entries from
  // the cap.  When the loop exhausts every entry without tripping a
  // limit, `start` stays 0 and `slice(0)` returns the full transcript.
  let start = 0;
  let budgetTripped = false;

  for (let i = transcript.length - 1; i >= 0; i--) {
    if (budgetTripped) break;
    const entry = transcript[i];
    const entryBytes = estimateEntryBytes(entry);

    // Entry-count cap is a strict ceiling: once we're at the limit, any
    // further entry must be dropped, even if it would complete a pair
    // with `lastKept` — at that point the thread is so long that losing
    // the tail pair is a smaller problem than re-uploading a stale
    // prefix.
    if (entries + 1 > maxEntries) {
      start = i + 1;
      budgetTripped = true;
      break;
    }

    // Byte cap — prefer keeping a tool-call / tool-result pair together
    // over a hard byte cut.  An orphaned tool_result (one without the
    // matching tool_call before it) would be an invalid chat-completions
    // message that the model rejects with 400, so the pair boundary is
    // where the helper's cap becomes advisory: we exceed maxBytes by
    // ONE pair rather than ship a malformed prefix.
    if (entries > 0 && bytes + entryBytes > maxBytes) {
      if (lastKept && isToolPairPartner(entry, lastKept)) {
        // Pair wins — keep the partner, accept the overflow, stop.
        lastKept = entry;
        bytes += entryBytes;
        entries++;
        start = i;
        budgetTripped = true;
        break;
      }
      start = i + 1;
      budgetTripped = true;
      break;
    }

    // First entry alone overflows the byte cap: keep it anyway (newest
    // entry always wins — dropping it would leave the model with no
    // prior context at all, which is worse than an oversized prefix).
    bytes += entryBytes;
    entries++;
    lastKept = entry;
  }

  // Whichever limit set `start`, the kept prefix must not open on a tool
  // result: its call was dropped, and an orphaned tool result is a message
  // the provider rejects with 400.  Skip past any leading result entries.
  while (start < transcript.length && isToolResultEntry(transcript[start])) start++;

  return transcript.slice(start);
}

/** True when `older` is the assistant tool call that `newer` answers:
 *  `older` carries toolCalls, `newer` carries toolResults, and at least
 *  one result id matches a call id.  Only that direction is a pair — an
 *  older RESULT before a newer CALL belongs to an earlier call, and keeping
 *  it would open the transcript on an orphaned result.  Used to detect when
 *  a byte cut would split a call from its result, and prefer to keep both
 *  halves even if that overflows the byte cap by a single entry. */
function isToolPairPartner(
  older: Transcript[number],
  newer: Transcript[number],
): boolean {
  if (!isToolCallEntry(older) || !isToolResultEntry(newer)) return false;
  const callIds = new Set(older.toolCalls!.map((call) => call.id));
  return newer.toolResults!.some((result) => callIds.has(result.id));
}

function isToolCallEntry(entry: Transcript[number]): boolean {
  return entry.role === "assistant" && (entry.toolCalls?.length ?? 0) > 0;
}

function isToolResultEntry(entry: Transcript[number]): boolean {
  return entry.role === "user" && (entry.toolResults?.length ?? 0) > 0;
}

/** Worst-case byte size of one transcript entry as it will appear on the
 *  wire (text body + tool-call arguments + tool-result payloads).
 *  Counts UTF-8 bytes — same encoder the provider sees — so a 100KB
 *  pasted stack trace round-trips as ~100KB and not as 50K chars. */
function estimateEntryBytes(entry: Transcript[number]): number {
  let n = utf8ByteLength(entry.text ?? "");
  if (entry.toolCalls) {
    for (const tc of entry.toolCalls) {
      n += utf8ByteLength(tc.id) + utf8ByteLength(tc.name) + utf8ByteLength(tc.arguments);
    }
  }
  if (entry.toolResults) {
    for (const tr of entry.toolResults) {
      n += utf8ByteLength(tr.id) + utf8ByteLength(tr.result);
    }
  }
  return n;
}

function utf8ByteLength(s: string): number {
  if (!s) return 0;
  // Buffer.byteLength is the only portable way to count UTF-8 bytes from
  // a JS string; the obvious `new TextEncoder().encode(s).length` works
  // too but allocates a Uint8Array on every call, which the loop above
  // would do thousands of times for a long transcript.
  return Buffer.byteLength(s, "utf8");
}

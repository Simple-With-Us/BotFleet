// Building the text a driver actually receives. Two situations force an
// inline replay of the active branch: a rewind (the visible branch
// changed) and a fresh engine (this instance has no session here — the
// user switched the bot's model mid-thread). They coincide today but are
// distinct markers on purpose: rewound also invalidates OTHER instances'
// cursors, fresh does not.
export interface TurnContextInput {
  /** the user's new message */
  text: string;
  /** settled text turns on the active branch, oldest first, capped upstream */
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  /** the visible branch changed (edit / version switch) */
  rewound: boolean;
  /** this driver instance has no session cursor for this thread */
  fresh: boolean;
  /** transcript-replay drivers get history via SendTurnInput.transcript instead */
  replaysNatively: boolean;
}

/** Does this engine need the thread replayed to it? True when a DIFFERENT
 * instance ran the last turn here — a cursor of our own is not enough,
 * because it only proves we once had a session covering some prefix of the
 * thread; every turn another engine took since is missing from it. Tasks
 * from before `lastInstanceId` existed fall back to the cursor map: a lone
 * cursor that is ours means a single-engine thread we can keep resuming;
 * anything else is ambiguous, and replaying is the safe side of ambiguous.
 * Gated on a prior USER turn: a new bot's thread is seeded with its own
 * greeting, and that alone is nothing to join. */
export function engineIsFresh(input: {
  instanceId: string;
  lastInstanceId: string | undefined;
  resumeCursors: Record<string, unknown>;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): boolean {
  const { instanceId, lastInstanceId, resumeCursors, transcript } = input;
  if (!transcript.some((m) => m.role === "user")) return false;
  if (lastInstanceId !== undefined) return lastInstanceId !== instanceId || resumeCursors[instanceId] === undefined;
  const cursorIds = Object.keys(resumeCursors);
  return !(cursorIds.length === 1 && cursorIds[0] === instanceId);
}

const REWOUND_PREAMBLE =
  "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]";
const FRESH_PREAMBLE =
  "[You are joining this conversation mid-thread (the user switched this bot over to you). The conversation so far:]";

const MAX_REPLAY_BYTES = 128 * 1024;
const OMITTED_HISTORY = "[Earlier conversation omitted for length]";

/** Chat-completions drivers resend this history on every request and tool round.
 * Keep its newest complete turns within a byte budget; one oversized newest
 * turn is clipped so a single paste cannot defeat the limit. */
export function boundNativeTranscript(
  transcript: Array<{ role: "user" | "assistant"; text: string }>,
): Array<{ role: "user" | "assistant"; text: string }> {
  // Leave space for the notice and message framing in the provider payload.
  const contentBudget = MAX_REPLAY_BYTES - Buffer.byteLength(OMITTED_HISTORY, "utf8") - 64;
  const kept: typeof transcript = [];
  let bytes = 0;
  let omitted = false;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    const entryBytes = Buffer.byteLength(entry.text, "utf8");
    if (bytes + entryBytes > contentBudget) {
      omitted = true;
      if (kept.length === 0) {
        kept.unshift({ ...entry, text: clipUtf8(entry.text, contentBudget) });
      }
      break;
    }
    kept.unshift(entry);
    bytes += entryBytes;
  }
  if (!omitted) return transcript;
  kept.unshift({ role: "user", text: OMITTED_HISTORY });
  return kept;
}

/** Room turns send recent messages as one prompt.  Keep the newest message
 * intact when it triggered the turn; a card continuation instead makes all
 * stored messages prior history.  An oversized current message needs a
 * separate explicit size error rather than truncation (board 93034769). */
export function boundRoomContextLines(lines: string[], preserveNewest = true): string {
  if (lines.length === 0) return "";
  const newest = lines[lines.length - 1];
  const noticeBytes = Buffer.byteLength(OMITTED_HISTORY, "utf8") + 1;
  // A card/secret continuation is the current prompt, so even the newest
  // stored room line is prior history and may be clipped when oversized.
  if (!preserveNewest && Buffer.byteLength(newest, "utf8") > MAX_REPLAY_BYTES - noticeBytes) {
    return `${OMITTED_HISTORY}\n${clipUtf8(newest, MAX_REPLAY_BYTES - noticeBytes)}`;
  }
  const earlierBudget = Math.max(
    0,
    MAX_REPLAY_BYTES - noticeBytes - Buffer.byteLength(newest, "utf8"),
  );
  const kept = [newest];
  let bytes = 0;
  let omitted = false;
  for (let i = lines.length - 2; i >= 0; i--) {
    const entryBytes = Buffer.byteLength(lines[i], "utf8") + 1;
    if (bytes + entryBytes > earlierBudget) {
      omitted = true;
      break;
    }
    kept.unshift(lines[i]);
    bytes += entryBytes;
  }
  return (omitted ? [OMITTED_HISTORY, ...kept] : kept).join("\n");
}

/** Clip a string to at most `maxBytes` of UTF-8 without splitting a character. */
function clipUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  // Back off to the start of the last complete code point.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export function buildTurnContext(input: TurnContextInput): {
  turnText: string;
  /** false when the native session must not be resumed */
  resume: boolean;
} {
  const { text, transcript, rewound, fresh, replaysNatively } = input;
  const resume = !rewound && !fresh;
  const replay = !resume && !replaysNatively && transcript.length > 0;
  if (!replay) return { turnText: text, resume };

  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = `${transcript[i].role === "user" ? "User" : "Assistant"}: ${transcript[i].text}`;
    const entryBytes = Buffer.byteLength(entry, "utf8");
    if (bytes + entryBytes > MAX_REPLAY_BYTES) {
      truncated = true;
      if (lines.length === 0) {
        // The newest entry alone is over budget — a single pasted message or a
        // long generated output.  Clip it instead of replaying it whole, so one
        // oversized entry cannot defeat the cap the omission marker promises.
        lines.unshift(clipUtf8(entry, MAX_REPLAY_BYTES));
        bytes += Buffer.byteLength(lines[0], "utf8");
      }
      break;
    }
    lines.unshift(entry);
    bytes += entryBytes;
  }

  const preamble = rewound ? REWOUND_PREAMBLE : FRESH_PREAMBLE;
  return {
    turnText: [
      preamble,
      ...(truncated ? [OMITTED_HISTORY, ""] : [""]),
      ...lines,
      "",
      "[Now reply to the user's latest message:]",
      "",
      text,
    ].join("\n"),
    resume,
  };
}

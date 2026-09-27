// The stable/volatile prompt split, shared by the drivers that deliver it.
// The stable half is everything that must stay byte-identical for a
// provider's cached prefix (or a spawned CLI's session contract) to
// survive; the volatile half (memory, mentions) legitimately changes
// mid-conversation and reaches the model inside the turn that changed it,
// after the cacheable prefix.
//
// Three delivery shapes share this module:
//   - the Claude driver keys its warm CLI process on the stable half and
//     delivers the volatile half inside the user turn when its digest
//     differs from the receipt the native session last carried;
//   - the HTTP chat-completions drivers (Grok, MiniMax, OpenAI-compatible)
//     send the stable half as the system message and carry the volatile
//     half on the newest user message every request;
//   - Codex and the ACP engines still send the whole prompt (see
//     joinedSystemPrompt) until a later package moves them to receipts.
// Ported from OpenMausBot `server/drivers/prompt-split.ts` (upstream PR
// #1758, building on #1031).
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import type { SendTurnInput } from "../contracts.ts";

/** The halves of a turn's system prompt.  The stable half is null for a
 * legacy single-block turn, so callers keep their pre-split behaviour. */
export interface PromptHalves {
  stable: string | null;
  volatile: string;
}

type SplitTurn = Pick<SendTurnInput, "system" | "systemStable" | "systemVolatile">;

/** Read the split off a turn.  Both halves must be present: a driver that
 * receives only the unsplit system field was called through a path that
 * never split it. */
export function promptHalves(turn: SplitTurn): PromptHalves {
  const { systemStable, systemVolatile } = turn;
  if (typeof systemStable !== "string" || typeof systemVolatile !== "string") {
    return { stable: null, volatile: "" };
  }
  return { stable: systemStable, volatile: systemVolatile };
}

/** The whole prompt for a driver that has not adopted the split yet.  The
 * server's ordered join is authoritative when it exists (a volatile section
 * may sit between two stable ones, so the halves back to back are not the
 * same bytes); a caller that only supplied the halves gets them joined.
 * Byte-identical to reading `turn.system` on every turn the server sends. */
export function joinedSystemPrompt(turn: SplitTurn): string | undefined {
  if (typeof turn.system === "string") return turn.system;
  const halves = promptHalves(turn);
  return halves.stable === null ? undefined : halves.stable + halves.volatile;
}

export const VOLATILE_CONTEXT_NOTE_PREFIX =
  "Context notes from BotFleet for this conversation; they replace any earlier copy of these notes:";

export const VOLATILE_CONTEXT_CLEARED_NOTE =
  "The context notes BotFleet delivered earlier in this conversation (memory, mentions) have been cleared; the standing instructions still apply.";

/** The labelled block that carries a volatile half inside a user turn.  A
 * half that is empty and always was needs no note; one that was cleared
 * announces the removal so the model stops relying on it. */
export function volatileContextNote(volatile: string, hadVolatile: boolean): string {
  const text = volatile.trim();
  if (text) return VOLATILE_CONTEXT_NOTE_PREFIX + "\n\n" + text;
  return hadVolatile ? VOLATILE_CONTEXT_CLEARED_NOTE : "";
}

/** Prepend a delivered note to the turn text: the one composition shape
 * every split-aware driver uses. */
export function withContextNote(note: string, text: string): string {
  if (!note) return text;
  return text ? note + "\n\n" + text : note;
}

/** The request head and newest user text for a driver that rebuilds its
 * chat-completions request from a transcript every turn (Grok, MiniMax,
 * OpenAI-compatible).  The system message heads the resent prefix, so only
 * the stable half belongs there: a volatile edit must not re-price the
 * tools, instructions and transcript the provider already cached.  The
 * volatile half rides the newest user message instead, every request: the
 * stored transcript never contains the delivered notes, so a digest-gated
 * delivery would leave the model without its memory on unchanged turns, and
 * the newest message is fresh input on every request anyway.  A legacy
 * unsplit turn keeps its whole prompt in the system message. */
export function splitChatPrompt(turn: SplitTurn & Pick<SendTurnInput, "text">): { system: string | undefined; text: string } {
  const halves = promptHalves(turn);
  if (halves.stable === null) return { system: turn.system || undefined, text: turn.text };
  return { system: halves.stable || undefined, text: withContextNote(volatileContextNote(halves.volatile, false), turn.text) };
}

/** Fingerprints of the halves a durable native session last carried. */
export interface PromptSplitReceipt {
  stable: string;
  volatile: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export const EMPTY_FINGERPRINT = digest("");

export function promptSplitFingerprints(stable: string, volatile: string): PromptSplitReceipt {
  return { stable: digest(stable), volatile: digest(volatile) };
}

const RECEIPT_DIR = "prompt-split";

const receiptDir = () => join(DATA_DIR, RECEIPT_DIR);
const receiptPath = (scope: string, key: string) => join(receiptDir(), digest(JSON.stringify([scope, key])) + ".json");

/** Which halves a native session (a Claude CLI session id, later an ACP
 * session id) last carried.  Unknown, whether never tracked or tracked
 * before this file existed, reads as null, and the caller delivers the
 * volatile half once.  Kept as one small file per session under the data
 * directory rather than on the task's resume cursor: a driver holds no
 * store handle, and the cursor's string shape is load-bearing across
 * fallback and recovery. */
export function readPromptSplitReceipt(scope: string, key: string): PromptSplitReceipt | null {
  try {
    const raw = JSON.parse(readFileSync(receiptPath(scope, key), "utf8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as { stable?: unknown; volatile?: unknown };
      if (typeof record.stable === "string" && typeof record.volatile === "string") {
        return { stable: record.stable, volatile: record.volatile };
      }
    }
  } catch {
    /* a missing or corrupt receipt is simply unknown */
  }
  return null;
}

export function writePromptSplitReceipt(scope: string, key: string, receipt: PromptSplitReceipt): void {
  mkdirSync(receiptDir(), { recursive: true });
  writeFileAtomic(receiptPath(scope, key), JSON.stringify(receipt), { mode: 0o600 });
}

/** Forget what a session carried, so the next turn delivers the volatile
 * half again.  Used when a delivery may not have reached the provider's
 * durable history (a CLI that died right after accepting the turn): a
 * repeated note costs a few hundred bytes, a skipped one loses the memory
 * for the rest of the session. */
export function clearPromptSplitReceipt(scope: string, key: string): void {
  try {
    unlinkSync(receiptPath(scope, key));
  } catch {
    /* nothing to forget */
  }
}

/** Best-effort removal of receipts untouched for longer than `maxAgeMs`.  A
 * receipt outlives its session by design (the session id is the only key
 * a driver has), so this keeps the directory proportional to recent
 * sessions; a swept receipt merely re-delivers one note. */
export const PROMPT_SPLIT_RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function sweepPromptSplitReceipts(maxAgeMs = PROMPT_SPLIT_RECEIPT_MAX_AGE_MS, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(receiptDir());
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(receiptDir(), name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) {
        unlinkSync(path);
        removed++;
      }
    } catch {
      /* raced with a writer or already gone */
    }
  }
  return removed;
}

/** Compose the prompt for a session that persists its own history (the
 * ACP engines, once they adopt receipts): the full system block rides only
 * when this native session has not carried it, or carried a different
 * stable half, which re-delivers the current copy the way a pre-split turn
 * always did; a changed volatile half rides as a labelled note.  Otherwise
 * the turn text goes through bare, so an ordinary memory write neither
 * appends a second copy of the prompt to the session nor re-prices its
 * cached prefix.  `perTurnVolatile` marks a turn whose volatile half
 * describes this very turn (a mention): its note is delivered even when the
 * text is unchanged. */
export function splitSessionPrompt(
  stable: string,
  volatile: string,
  previous: PromptSplitReceipt | null,
  fullSystem: string | undefined,
  text: string,
  perTurnVolatile = false,
): { text: string; receipt: PromptSplitReceipt } {
  const receipt = promptSplitFingerprints(stable, volatile);
  if (previous === null || previous.stable !== receipt.stable) {
    return { text: fullSystem ? fullSystem + "\n\n" + text : text, receipt };
  }
  const note = previous.volatile === receipt.volatile && !perTurnVolatile
    ? ""
    : volatileContextNote(volatile, previous.volatile !== EMPTY_FINGERPRINT);
  return { text: withContextNote(note, text), receipt };
}

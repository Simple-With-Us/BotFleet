// Per-turn byte budget for the prompt ACP sends on session/prompt.
//
// Traced turns were handing the model the composed prompt with no ceiling
// (about 158k input tokens on average, 362k at the max).  This trims that
// text before it is sent.  It does not skip re-inlining the system prompt
// on resume; that is a separate change.  Under the budget the composed
// prompt is returned byte for byte.
//
// What may go, oldest first: replayed history sections (prior turns, oldest
// first), then volatile system sections by cut priority (stale nudges before
// the bot's memory; see ACP_SECTION_CUT_PRIORITY).  Those are the parts that legitimately change
// between turns.  The stable system block and the current user message
// stay, even when they alone are already over the budget.
import { z } from "zod";

import {
  FRESH_PREAMBLE,
  OMITTED_HISTORY,
  REWOUND_PREAMBLE,
  ROOM_REPLY_PREFIX,
  TURN_REPLY_CUE,
} from "../../turn-context.ts";

/** UTF-8 ceiling used when an instance does not set one.  128 KiB is the
 *  same order as the inline-replay cap: a normal system prompt (tens of
 *  KB) plus the current message fits, and a pathological volatile block
 *  or replay does not. */
export const DEFAULT_ACP_PROMPT_BUDGET_BYTES = 128 * 1024;

/** The hard ceiling is this many times the budget.  The budget trims what it
 *  may; the protected system text and the current message are never cut, so a
 *  turn can still end up over it.  Past this multiple the turn is refused
 *  rather than sent. */
export const ACP_PROMPT_HARD_CEILING_FACTOR = 2;

/** Which volatile section is cut first when the budget bites: lowest number
 *  goes first, ties in prompt order.  Replaced the old rule, which cut volatile
 *  sections in the order they appear in the prompt (so memory always went
 *  before a later mentions note).  Per-turn nudges and stale lists go before the
 *  bot's own memory and the instructions a message selected.  Ids not listed
 *  sit in the middle. */
export const ACP_SECTION_CUT_PRIORITY: Readonly<Record<string, number>> = {
  recent: 10,
  mentions: 20,
  outstanding: 30,
  automation: 40,
  playbooks: 50,
  "skill-instructions": 60,
  memory: 70,
};
const UNLISTED_SECTION_PRIORITY = 35;

function cutPriority(id: string | undefined): number {
  return (id && ACP_SECTION_CUT_PRIORITY[id]) || UNLISTED_SECTION_PRIORITY;
}

/** Largest accepted instance setting.  Above this the value is ignored
 *  and the default applies. */
export const MAX_ACP_PROMPT_BUDGET_BYTES = 8 * 1024 * 1024;

/** One line, substituted for each section the budget drops. */
export const ACP_PROMPT_SECTION_OMITTED = "[Earlier section omitted to fit the prompt budget]";

const promptBudgetBytesSchema = z.union([
  z.literal(0),
  z.number().int().min(1).max(MAX_ACP_PROMPT_BUDGET_BYTES),
]);

export interface AcpPromptSection {
  id: string;
  text: string;
  volatile: boolean;
}

export interface AcpPromptBytes {
  stable: number;
  volatile: number;
}

/** What a trim took out, by name only.  No prompt text. */
export interface AcpPromptDropped {
  /** Replayed history turns removed or replaced by the omission marker. */
  historyTurns: number;
  /** Ids of the volatile system sections replaced (for example "memory"). */
  sections: string[];
}

export interface AcpPromptBudgetResult {
  text: string;
  /** Stable is the protected system block.  Volatile is every volatile
   *  system section plus replayed history: the bytes this budget may
   *  replace.  With no inline replay, volatile matches the system prompt's
   *  volatile half. */
  before: AcpPromptBytes;
  after: AcpPromptBytes;
  trimmed: boolean;
  /** What the trim removed.  Empty when nothing was trimmed. */
  dropped: AcpPromptDropped;
}

const NOTHING_DROPPED: AcpPromptDropped = { historyTurns: 0, sections: [] };

/** `0` disables the budget.  A positive integer up to the max is a ceiling.
 *  Anything else is ignored so the caller keeps the default. */
export function decodeAcpPromptBudgetBytes(raw: unknown): number | undefined {
  const parsed = promptBudgetBytesSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** `undefined` is the default ceiling.  `0` is off. */
export function resolveAcpPromptBudgetBytes(configured: number | undefined): number | null {
  if (configured === 0) return null;
  return configured ?? DEFAULT_ACP_PROMPT_BUDGET_BYTES;
}

interface Piece {
  kind: "stable" | "volatile" | "history";
  text: string;
  /** The section id, for system pieces built from named sections. */
  id?: string;
}

interface SplitHistory {
  /** Non-trimmable harness text before replayed turns (inline preambles). */
  userStablePrefix: string;
  history: Piece[];
  current: string;
}

function utf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Keep the section's surrounding newlines so the marker stays on its own
 *  line.  A block that is only newlines is returned unchanged. */
function omittedReplacement(text: string): string {
  const leading = /^\n*/.exec(text)?.[0] ?? "";
  if (leading.length === text.length) return text;
  const trailing = /\n*$/.exec(text)?.[0] ?? "";
  return leading + ACP_PROMPT_SECTION_OMITTED + trailing;
}

function shrinks(text: string): boolean {
  return utf8(omittedReplacement(text)) < utf8(text);
}

function measure(
  system: readonly Piece[],
  history: readonly Piece[],
  userStablePrefix: string,
): AcpPromptBytes {
  let stable = 0;
  let volatile = 0;
  for (const piece of system) {
    const bytes = utf8(piece.text);
    if (piece.kind === "stable") stable += bytes;
    else volatile += bytes;
  }
  volatile += utf8(userStablePrefix);
  // The newline join is part of the replay the model reads, so it counts.
  volatile += utf8(history.map((piece) => piece.text).join("\n"));
  return { stable, volatile };
}

function renderUserText(userStablePrefix: string, history: readonly Piece[], current: string): string {
  const historyText = history.map((piece) => piece.text).join("\n");
  return userStablePrefix + historyText + current;
}

function render(
  system: readonly Piece[],
  history: readonly Piece[],
  current: string,
  userStablePrefix = "",
): string {
  const systemText = system.map((piece) => piece.text).join("");
  const userText = renderUserText(userStablePrefix, history, current);
  if (systemText && userText) return `${systemText}\n\n${userText}`;
  return systemText || userText;
}

function composedBytes(
  system: readonly Piece[],
  history: readonly Piece[],
  current: string,
  userStablePrefix: string,
): number {
  const systemText = system.map((piece) => piece.text).join("");
  const userText = renderUserText(userStablePrefix, history, current);
  if (systemText && userText) return utf8(systemText) + 2 + utf8(userText);
  return utf8(systemText || userText);
}

/** The system prefix of a `${system}\n\n${userText}` composition, or ""
 *  when the prompt is only the user text.  Null when the composition is
 *  not that shape, in which case nothing is rewritten. */
function peelSystem(composed: string, userText: string): string | null {
  if (composed === userText) return "";
  const suffix = `\n\n${userText}`;
  if (!composed.endsWith(suffix)) return null;
  return composed.slice(0, composed.length - suffix.length);
}

const INLINE_REPLAY_LINE = /(?:^|\n)(?:User|Assistant): /;
const ROOM_CONTEXT_LINE = /(?:^|\n)[^:\n]+: /;
/** Harness delimiter from `buildTurnContext` — not a bare `TURN_REPLY_CUE`
 *  substring, which the current message may quote. */
const INLINE_REPLY_BOUNDARY = `\n\n${TURN_REPLY_CUE}\n\n`;
/** Full room instruction line from `runGroupMemberTurn` — not the prefix
 *  alone, which `cardContinuation` may quote after the boundary. */
const ROOM_REPLY_BOUNDARY_RE = new RegExp(
  `\\n\\n${ROOM_REPLY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]+\\.\\)`,
  "g",
);
const INLINE_TURN_SPLIT = /\n(?=(?:User|Assistant): )/;
const ROOM_MESSAGE_SPLIT = /\n(?=[^:\n]+: )/;

function lastRoomReplyBoundaryAt(userText: string): number {
  const re = ROOM_REPLY_BOUNDARY_RE;
  re.lastIndex = 0;
  let boundaryAt = -1;
  for (let match = re.exec(userText); match; match = re.exec(userText)) {
    boundaryAt = match.index;
  }
  return boundaryAt;
}

/** Preamble and omission markers from `buildTurnContext` — not trimmable. */
function peelInlineHarnessPrefix(region: string) {
  const preamble =
    region.startsWith(REWOUND_PREAMBLE) ? REWOUND_PREAMBLE
    : region.startsWith(FRESH_PREAMBLE) ? FRESH_PREAMBLE
    : null;
  if (!preamble) return { prefix: "", body: region };
  let pos = preamble.length;
  if (region[pos] === "\n") pos++;
  if (region.slice(pos).startsWith(OMITTED_HISTORY)) {
    pos += OMITTED_HISTORY.length;
    if (region[pos] === "\n") pos++;
  }
  if (region[pos] === "\n") pos++;
  return { prefix: region.slice(0, pos), body: region.slice(pos) };
}

function splitInlineReplay(userText: string): SplitHistory | null {
  const boundaryAt = userText.lastIndexOf(INLINE_REPLY_BOUNDARY);
  if (boundaryAt < 0) return null;
  const region = userText.slice(0, boundaryAt);
  if (!INLINE_REPLAY_LINE.test(region)) return null;
  const { prefix, body } = peelInlineHarnessPrefix(region);
  if (!INLINE_REPLAY_LINE.test(body)) return null;
  const parts = body.split(INLINE_TURN_SPLIT);
  return {
    userStablePrefix: prefix,
    history: parts.map((text) => ({ kind: "history" as const, text })),
    current: userText.slice(boundaryAt),
  };
}

function splitRoomReplay(userText: string): SplitHistory | null {
  const boundaryAt = lastRoomReplyBoundaryAt(userText);
  if (boundaryAt < 0) return null;
  const region = userText.slice(0, boundaryAt);
  if (!ROOM_CONTEXT_LINE.test(region)) return null;
  const messages = region.split(ROOM_MESSAGE_SPLIT);
  if (messages.length === 0) {
    return { userStablePrefix: "", history: [], current: userText.slice(boundaryAt) };
  }
  const newest = messages.pop()!;
  const historyJoin = messages.length > 0 ? "\n" : "";
  return {
    userStablePrefix: "",
    history: messages.map((text) => ({ kind: "history" as const, text })),
    current: `${historyJoin}${newest}${userText.slice(boundaryAt)}`,
  };
}

/** Prior turns inside a replayed user message.  Without a harness boundary
 *  the whole user text is the current message and is not split. */
function splitHistory(userText: string): SplitHistory {
  return (
    splitInlineReplay(userText)
    ?? splitRoomReplay(userText)
    ?? { userStablePrefix: "", history: [], current: userText }
  );
}

function systemPieces(systemText: string, sections: readonly AcpPromptSection[] | undefined): Piece[] {
  const listed = (sections ?? []).filter((section) => section.text.length > 0);
  const joined = listed.map((section) => section.text).join("");
  if (listed.length > 0 && joined === systemText) {
    return listed.map((section) => ({
      kind: section.volatile ? "volatile" : "stable",
      text: section.text,
      id: section.id,
    }));
  }
  return systemText.length > 0 ? [{ kind: "stable", text: systemText }] : [];
}

/**
 * Apply the budget to an already composed ACP prompt.
 *
 * `budgetBytes` null (or `0`) disables trimming.  A prompt that already
 * fits is returned unchanged.  A composition this function cannot segment
 * is also returned unchanged: guessing at section boundaries would risk
 * cutting the stable block or the current message.
 */
export function applyAcpPromptBudget(input: {
  composed: string;
  sections?: readonly AcpPromptSection[];
  userText: string;
  budgetBytes: number | null;
}): AcpPromptBudgetResult {
  const systemText = peelSystem(input.composed, input.userText);
  if (systemText === null) {
    const bytes = utf8(input.composed);
    const whole = { stable: bytes, volatile: 0 };
    return { text: input.composed, before: whole, after: whole, trimmed: false, dropped: NOTHING_DROPPED };
  }

  const system = systemPieces(systemText, input.sections);
  const { userStablePrefix, history, current } = splitHistory(input.userText);
  const before = measure(system, history, userStablePrefix);
  const unchanged = (): AcpPromptBudgetResult => ({
    text: input.composed,
    before,
    after: before,
    trimmed: false,
    dropped: NOTHING_DROPPED,
  });

  if (render(system, history, current, userStablePrefix) !== input.composed) return unchanged();
  const budget = input.budgetBytes;
  if (budget == null || budget <= 0 || utf8(input.composed) <= budget) return unchanged();

  const nextSystem = system.map((piece) => ({ ...piece }));
  const nextHistory = history.map((piece) => ({ ...piece }));
  const finalizedHistory = new Set<number>();
  let trimmed = false;
  let droppedTurns = 0;
  const droppedSections: string[] = [];

  let totalBytes = composedBytes(nextSystem, nextHistory, current, userStablePrefix);
  while (totalBytes > budget) {
    const historyIndex = nextHistory.findIndex(
      (piece, index) => piece.text.length > 0 && !finalizedHistory.has(index),
    );
    if (historyIndex >= 0) {
      const piece = nextHistory[historyIndex]!;
      const oldBytes = utf8(piece.text);
      if (shrinks(piece.text)) {
        const replacement = omittedReplacement(piece.text);
        nextHistory[historyIndex] = { kind: "history", text: replacement };
        totalBytes += utf8(replacement) - oldBytes;
        finalizedHistory.add(historyIndex);
      } else {
        const joinOverhead = nextHistory.length > 1 ? 1 : 0;
        nextHistory.splice(historyIndex, 1);
        totalBytes -= oldBytes + joinOverhead;
      }
      trimmed = true;
      droppedTurns += 1;
      continue;
    }
    let volatileIndex = -1;
    for (let i = 0; i < nextSystem.length; i++) {
      const piece = nextSystem[i]!;
      if (piece.kind !== "volatile" || !shrinks(piece.text)) continue;
      if (volatileIndex < 0 || cutPriority(piece.id) < cutPriority(nextSystem[volatileIndex]!.id)) volatileIndex = i;
    }
    if (volatileIndex < 0) break;
    const oldBytes = utf8(nextSystem[volatileIndex].text);
    const replacement = omittedReplacement(nextSystem[volatileIndex].text);
    nextSystem[volatileIndex] = {
      kind: "volatile",
      text: replacement,
      id: nextSystem[volatileIndex].id,
    };
    totalBytes += utf8(replacement) - oldBytes;
    trimmed = true;
    const sectionId = nextSystem[volatileIndex].id;
    if (sectionId && !droppedSections.includes(sectionId)) droppedSections.push(sectionId);
  }

  if (!trimmed) return unchanged();
  return {
    text: render(nextSystem, nextHistory, current, userStablePrefix),
    before,
    after: measure(nextSystem, nextHistory, userStablePrefix),
    trimmed: true,
    dropped: { historyTurns: droppedTurns, sections: droppedSections },
  };
}

function kib(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
}

/** The "Compressing Context" record for a trimmed prompt: one line for the row
 *  and the expanded text.  Counts, byte sizes and section names only; no prompt
 *  text.  Null when nothing was trimmed. */
export function describeAcpPromptTrim(
  result: AcpPromptBudgetResult,
  budgetBytes: number | null,
): { preview: string; text: string; bytesSaved: number } | null {
  if (!result.trimmed) return null;
  const before = result.before.stable + result.before.volatile;
  const after = result.after.stable + result.after.volatile;
  const { historyTurns, sections } = result.dropped;
  const parts: string[] = [];
  if (historyTurns > 0) parts.push(`${historyTurns} earlier ${historyTurns === 1 ? "turn" : "turns"}`);
  if (sections.length > 0) parts.push(sections.join(", "));
  const preview = `${kib(before)} to ${kib(after)}${parts.length ? `: dropped ${parts.join(" and ")}` : ""}`;
  const lines = [
    "The prompt was over this bot's per-turn budget, so older context was cut before it was sent.",
    "",
    `Budget: ${budgetBytes == null ? "none" : kib(budgetBytes)}`,
    `Before: ${kib(before)}  (protected ${kib(result.before.stable)}, trimmable ${kib(result.before.volatile)})`,
    `After: ${kib(after)}  (protected ${kib(result.after.stable)}, trimmable ${kib(result.after.volatile)})`,
    `Earlier turns dropped: ${historyTurns}`,
    `Sections dropped: ${sections.length ? sections.join(", ") : "none"}`,
    "",
    "Each dropped part was replaced by an omission marker.  The system instructions and your message were kept.",
  ];
  return { preview, text: lines.join("\n"), bytesSaved: Math.max(0, before - after) };
}

/** The refusal for a prompt that is still over the hard ceiling after trimming,
 *  or null when it may be sent.  Names sizes only. */
export function acpPromptCeilingRefusal(
  text: string,
  budgetBytes: number | null,
): { message: string; bytes: number; ceiling: number } | null {
  if (budgetBytes == null || budgetBytes <= 0) return null;
  const ceiling = budgetBytes * ACP_PROMPT_HARD_CEILING_FACTOR;
  const bytes = utf8(text);
  if (bytes <= ceiling) return null;
  return {
    bytes,
    ceiling,
    message:
      `This turn was not sent: the part that cannot be trimmed (system instructions plus your message) is ${kib(bytes)}, `
      + `over the ${kib(ceiling)} hard limit (twice the ${kib(budgetBytes)} budget).  `
      + "Shorten the message, or raise promptBudgetBytes for this bot.",
  };
}

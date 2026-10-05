// Per-turn byte budget for the prompt ACP sends on session/prompt.
//
// Traced turns were handing the model the composed prompt with no ceiling
// (about 158k input tokens on average, 362k at the max).  This trims that
// text before it is sent.  It does not skip re-inlining the system prompt
// on resume; that is a separate change.  Under the budget the composed
// prompt is returned byte for byte.
//
// What may go, oldest first: replayed history sections (prior turns, oldest
// first), then volatile system sections in prompt order (memory before a
// later mentions note).  Those are the parts that legitimately change
// between turns.  The stable system block and the current user message
// stay, even when they alone are already over the budget.
import { z } from "zod";

import { ROOM_REPLY_PREFIX, TURN_REPLY_CUE } from "../../turn-context.ts";

/** UTF-8 ceiling used when an instance does not set one.  128 KiB is the
 *  same order as the inline-replay cap: a normal system prompt (tens of
 *  KB) plus the current message fits, and a pathological volatile block
 *  or replay does not. */
export const DEFAULT_ACP_PROMPT_BUDGET_BYTES = 128 * 1024;

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

export interface AcpPromptBudgetResult {
  text: string;
  /** Stable is the protected system block.  Volatile is every volatile
   *  system section plus replayed history: the bytes this budget may
   *  replace.  With no inline replay, volatile matches the system prompt's
   *  volatile half. */
  before: AcpPromptBytes;
  after: AcpPromptBytes;
  trimmed: boolean;
}

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

function measure(system: readonly Piece[], history: readonly Piece[]): AcpPromptBytes {
  let stable = 0;
  let volatile = 0;
  for (const piece of system) {
    const bytes = utf8(piece.text);
    if (piece.kind === "stable") stable += bytes;
    else volatile += bytes;
  }
  // The newline join is part of the replay the model reads, so it counts.
  volatile += utf8(history.map((piece) => piece.text).join("\n"));
  return { stable, volatile };
}

function render(system: readonly Piece[], history: readonly Piece[], current: string): string {
  const systemText = system.map((piece) => piece.text).join("");
  const userText = history.map((piece) => piece.text).join("\n") + current;
  if (systemText && userText) return `${systemText}\n\n${userText}`;
  return systemText || userText;
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

function lastRoomReplyBoundaryAt(userText: string): number {
  const re = ROOM_REPLY_BOUNDARY_RE;
  re.lastIndex = 0;
  let boundaryAt = -1;
  for (let match = re.exec(userText); match; match = re.exec(userText)) {
    boundaryAt = match.index;
  }
  return boundaryAt;
}

function splitInlineReplay(userText: string): { history: Piece[]; current: string } | null {
  const boundaryAt = userText.lastIndexOf(INLINE_REPLY_BOUNDARY);
  if (boundaryAt < 0) return null;
  const region = userText.slice(0, boundaryAt);
  if (!INLINE_REPLAY_LINE.test(region)) return null;
  const parts = region.split(/\n(?=(?:User|Assistant): )/);
  return {
    history: parts.map((text) => ({ kind: "history" as const, text })),
    current: userText.slice(boundaryAt),
  };
}

function splitRoomReplay(userText: string): { history: Piece[]; current: string } | null {
  const boundaryAt = lastRoomReplyBoundaryAt(userText);
  if (boundaryAt < 0) return null;
  const region = userText.slice(0, boundaryAt);
  if (!ROOM_CONTEXT_LINE.test(region)) return null;
  const lines = region.split("\n").filter((line) => line.length > 0);
  return {
    history: lines.map((text) => ({ kind: "history" as const, text })),
    current: userText.slice(boundaryAt),
  };
}

/** Prior turns inside a replayed user message.  Without a harness boundary
 *  the whole user text is the current message and is not split. */
function splitHistory(userText: string): { history: Piece[]; current: string } {
  return splitInlineReplay(userText) ?? splitRoomReplay(userText) ?? { history: [], current: userText };
}

function systemPieces(systemText: string, sections: readonly AcpPromptSection[] | undefined): Piece[] {
  const listed = (sections ?? []).filter((section) => section.text.length > 0);
  const joined = listed.map((section) => section.text).join("");
  if (listed.length > 0 && joined === systemText) {
    return listed.map((section) => ({
      kind: section.volatile ? "volatile" : "stable",
      text: section.text,
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
    return { text: input.composed, before: whole, after: whole, trimmed: false };
  }

  const system = systemPieces(systemText, input.sections);
  const { history, current } = splitHistory(input.userText);
  const before = measure(system, history);
  const unchanged = (): AcpPromptBudgetResult => ({
    text: input.composed,
    before,
    after: before,
    trimmed: false,
  });

  if (render(system, history, current) !== input.composed) return unchanged();
  const budget = input.budgetBytes;
  if (budget == null || budget <= 0 || utf8(input.composed) <= budget) return unchanged();

  const nextSystem = system.map((piece) => ({ ...piece }));
  const nextHistory = history.map((piece) => ({ ...piece }));
  let trimmed = false;

  const size = () => utf8(render(nextSystem, nextHistory, current));
  while (size() > budget) {
    const historyIndex = nextHistory.findIndex(
      (piece) => piece.text.length > 0 && !piece.text.includes(ACP_PROMPT_SECTION_OMITTED),
    );
    if (historyIndex >= 0) {
      const piece = nextHistory[historyIndex]!;
      if (shrinks(piece.text)) {
        nextHistory[historyIndex] = { kind: "history", text: omittedReplacement(piece.text) };
      } else {
        nextHistory.splice(historyIndex, 1);
      }
      trimmed = true;
      continue;
    }
    const volatileIndex = nextSystem.findIndex((piece) => piece.kind === "volatile" && shrinks(piece.text));
    if (volatileIndex < 0) break;
    nextSystem[volatileIndex] = {
      kind: "volatile",
      text: omittedReplacement(nextSystem[volatileIndex].text),
    };
    trimmed = true;
  }

  if (!trimmed) return unchanged();
  return {
    text: render(nextSystem, nextHistory, current),
    before,
    after: measure(nextSystem, nextHistory),
    trimmed: true,
  };
}

// Content the harness put in front of the model that the person did not type.
//
// A turn's prompt is more than the message in the composer.  The harness adds
// the bot's MEMORY.md, the skills and playbooks the message triggered, a note
// about what automation fired the turn, a nudge for a tagged teammate, the
// quoted message a reply points at, and — when a different engine picks the
// thread up — the whole conversation so far.  None of it appears in the
// transcript, so a bot's behaviour could not be explained from what the page
// showed.
//
// Each of those becomes one lightweight record: a source, a short preview, and
// a size.  The record rides a `context.injected` runtime event (so the
// Trajectory lists it beside the steps it preceded) and a bounded list on the
// user message that started the turn (so the chat shows a quiet row under it).
// The full text is never persisted on the message; it goes to the same bounded
// side store a tool's input and output use, and is fetched when a row opens.

import { formatByteSize } from "./text-format.ts";

/** Every kind of injection the harness records.  Closed on purpose: the label
 * table below is a `Record<ContextSource, …>`, so a new source is a type error
 * until someone decides what it is called. */
export type ContextSource =
  /** the bot's own MEMORY.md */
  | "memory"
  /** bundled skill instructions a trigger term in the message selected */
  | "skill"
  /** installed playbook instructions the message selected */
  | "playbook"
  /** the note naming which automation (webhook, resource, iMessage) fired the turn */
  | "automation"
  /** the nudge to bring in a teammate the message tagged */
  | "mention"
  /** the conversation so far, replayed to an engine with no session of its own
   * to continue: one that joined mid-thread, or whose native session was lost */
  | "handoff"
  /** the surviving conversation, replayed after an edit or a version switch */
  | "rewind"
  /** the earlier message a reply quotes */
  | "reply"
  /** the note the harness sent as the whole turn when a card was finished
   * (a connector connected, a credential provided or declined) */
  | "continuation";

export const CONTEXT_SOURCES: readonly ContextSource[] = [
  "memory",
  "skill",
  "playbook",
  "automation",
  "mention",
  "handoff",
  "rewind",
  "reply",
  "continuation",
];

/** The word after "Context injection ·".  Lowercase on purpose: it is a value
 * in a row, not a heading. */
export const CONTEXT_SOURCE_LABEL: Record<ContextSource, string> = {
  memory: "memory",
  skill: "skill",
  playbook: "playbook",
  automation: "automation",
  mention: "mention",
  handoff: "handoff",
  rewind: "rewind",
  reply: "reply quote",
  continuation: "continuation",
};

/** What the chat persists on the user message for one injection.  Short by
 * construction: the preview is one clipped line and the full text lives in the
 * side store, keyed by `id`. */
export interface ContextInjectionRef {
  /** the side-store key, and the `itemId` of the runtime event */
  id: string;
  source: ContextSource;
  /** one redacted, clipped line of what was injected */
  preview: string;
  /** UTF-8 bytes of the full text */
  bytes: number;
}

/** Longest preview a record keeps. */
export const CONTEXT_PREVIEW_LIMIT = 160;

/** Most injections one turn records.  There are fewer sources than this, but a
 * bound stated is a bound enforced. */
export const MAX_CONTEXT_INJECTIONS_PER_TURN = 8;

export function isContextSource(value: unknown): value is ContextSource {
  return typeof value === "string" && (CONTEXT_SOURCES as readonly string[]).includes(value);
}

/** The row's label: "Context injection · memory". */
export function contextInjectionLabel(source: ContextSource): string {
  return `Context injection · ${CONTEXT_SOURCE_LABEL[source]}`;
}

/** A byte count as a person reads it, or "" for one that is not a size. */
export function formatContextBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  return formatByteSize(Math.round(bytes));
}

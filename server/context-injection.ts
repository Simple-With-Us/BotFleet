// Recording what the harness put in front of the model that the person did not
// type.  The vocabulary and the row live in `shared/context-injection.ts`; this
// is the server half: which parts of an assembled turn count, how each becomes
// a record, and how a record reaches the two places that show it.
//
// What counts is narrow on purpose.  A turn's prompt holds a great deal of
// standing configuration — the bot's identity, its tool budget, the team
// roster, the owner's notes — that is the same every turn and is the bot's
// definition rather than something that happened.  Recording it per turn would
// bury the rows that explain a change.  These are what is chosen, or changes,
// per turn:
//
//   memory       the bot's MEMORY.md, re-recorded only when its text changed
//   skill        skill instructions a trigger term in THIS message selected
//   playbook     installed playbook instructions this message selected
//   automation   the note naming which automation fired THIS turn
//   mention      the nudge to bring in a teammate THIS message tagged
//   handoff      the conversation replayed to an engine with no session of its
//                own: one that joined mid-thread, or whose session was lost
//   rewind       the surviving conversation replayed after an edit or switch
//   reply        the earlier message THIS message quotes
//   continuation the note the harness sent as the whole turn when a card was
//                finished (a connector connected, a credential provided)
//
// Not recorded, and why, is written up beside the call site in index.ts.
//
// Every record's preview is redacted BEFORE it is clipped (`describeResult`'s
// order, for the same reason: a secret cut in half loses the closing marker
// its pattern anchors on).  The full text is not persisted on the message; it
// rides the event's `io` capture into the bounded side store, which redacts it
// again.
import { createHash, randomUUID } from "node:crypto";

import { newEventId, type RuntimeEvent } from "./contracts.ts";
import {
  CONTEXT_PREVIEW_LIMIT,
  MAX_CONTEXT_INJECTIONS_PER_TURN,
  type ContextInjectionRef,
  type ContextSource,
} from "../shared/context-injection.ts";
import { boundText } from "../shared/item-io.ts";
import { MEMORY_CONTENT_HEADING } from "./workspace.ts";
import { describeResult } from "../shared/tool-activity.ts";

/** One injection before it is recorded. */
export interface InjectionDraft {
  source: ContextSource;
  /** the whole text the model received for it */
  text: string;
}

/** The prompt sections that are chosen per turn, and the source each is. */
const SECTION_SOURCES: ReadonlyArray<readonly [sectionId: string, source: ContextSource]> = [
  ["memory", "memory"],
  ["skill-instructions", "skill"],
  ["playbooks", "playbook"],
  ["automation", "automation"],
  ["mentions", "mention"],
];

/** Drafts for the per-turn sections of an assembled system prompt, in the
 * order the prompt lists them.  An empty section was not injected. */
export function draftsFromPromptSections(sections: ReadonlyArray<{ id: string; text: string }>): InjectionDraft[] {
  const drafts: InjectionDraft[] = [];
  for (const [sectionId, source] of SECTION_SOURCES) {
    const section = sections.find((candidate) => candidate.id === sectionId);
    let text = section?.text.trim();
    // The memory section is always present (guidance on where MEMORY.md lives
    // and how to keep it), and that guidance is the same every turn.  What was
    // injected is the bot's own notes, which follow the heading.
    if (source === "memory" && text) {
      const at = text.indexOf(MEMORY_CONTENT_HEADING);
      text = at === -1 ? undefined : text.slice(at + MEMORY_CONTENT_HEADING.length).trim();
    }
    if (text) drafts.push({ source, text });
  }
  return drafts;
}

/** The part of `turnText` the harness added in front of `promptText` — the
 * preamble and replayed history `buildTurnContext` wraps around a thread being
 * replayed — or null when the turn was sent as typed.  `promptText` is what
 * went IN to `buildTurnContext`; the replay is a prefix of what came out. */
export function draftFromReplay(turnText: string, promptText: string, kind: "handoff" | "rewind"): InjectionDraft | null {
  if (turnText === promptText || !turnText.endsWith(promptText)) return null;
  const text = turnText.slice(0, turnText.length - promptText.length).trim();
  return text ? { source: kind, text } : null;
}

/** The part of a reply's prompt the harness added in front of the message the
 * person typed: the framing and the quoted excerpt.  `replied` is what
 * `promptWithReply` returned, `typed` the text that went in. */
export function draftFromReply(replied: string, typed: string): InjectionDraft | null {
  if (replied === typed || !replied.endsWith(typed)) return null;
  const text = replied.slice(0, replied.length - typed.length).trim();
  return text ? { source: "reply", text } : null;
}

/** One redacted, clipped line of what was injected. */
export function injectionPreview(text: string): string {
  return describeResult(text, CONTEXT_PREVIEW_LIMIT) ?? "";
}

/** The drafts a message has not already recorded.
 *
 * One message can be dispatched more than once: a model fallback hands the same
 * message to the next engine, and each dispatch re-assembles the same prompt.
 * Two rows reading the same skill at the same size say nothing the first did
 * not, and the Trajectory would list the step twice too, so a draft that
 * matches a recorded one — same source, same size, same preview — is dropped
 * BEFORE it is published, which also keeps the side store from holding the text
 * twice.  A draft that differs (the second engine joined mid-thread and was
 * handed a replay the first never saw) is new and kept. */
export function dropRecorded(
  drafts: readonly InjectionDraft[],
  recorded: readonly ContextInjectionRef[] | undefined,
): InjectionDraft[] {
  if (!recorded || recorded.length === 0) return [...drafts];
  const seen = new Set(recorded.map((ref) => `${ref.source}\u0000${ref.bytes}\u0000${ref.preview}`));
  const kept: InjectionDraft[] = [];
  for (const draft of drafts) {
    const key = `${draft.source}\u0000${Buffer.byteLength(draft.text, "utf8")}\u0000${injectionPreview(draft.text)}`;
    // a repeat within one batch is the same duplicate
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(draft);
  }
  return kept;
}

/** A message's injections with `added` appended, newest last, and the list held
 * to what one turn may record. */
export function mergeInjectionRefs(
  earlier: readonly ContextInjectionRef[] | undefined,
  added: readonly ContextInjectionRef[],
): ContextInjectionRef[] {
  return [...(earlier ?? []), ...added].slice(-MAX_CONTEXT_INJECTIONS_PER_TURN);
}

/** The message the chat hangs a turn's injection rows under.
 *
 * Normally the stored message that started the turn.  A card continuation has
 * none: the harness wrote the prompt, nothing was appended to the transcript,
 * and the message object the turn carries was never stored.  Its rows go under
 * the last message on the active path — the card the person just finished, or
 * whatever the bot said last — which is where the turn began.  Null when the
 * thread has nothing to hang them on; the Trajectory still lists them. */
export function injectionTarget<M extends { id: string }>(input: {
  stored: readonly M[];
  userMessageId: string;
  /** the turn's own message was never stored (a card continuation) */
  unstored: boolean;
  activePath: readonly M[];
}): M | null {
  const own = input.stored.find((message) => message.id === input.userMessageId);
  if (own) return own;
  return input.unstored ? (input.activePath.at(-1) ?? null) : null;
}

/** Remembers the last memory text recorded per thread, so MEMORY.md — which
 * rides every turn — is recorded when it first appears and when it changes,
 * not on every message.  What is held is a digest, never the text: MEMORY.md
 * can be tens of kilobytes and a long-lived harness sees many threads, so
 * holding the text would pin megabytes for threads long since deleted.
 * Bounded: a forgotten entry costs one extra record, never a wrong one. */
export class MemoryChangeGate {
  private readonly seen = new Map<string, string>();
  private readonly limit: number;

  // An explicit field, not a parameter property: Node's strip-only TypeScript
  // mode refuses the latter at load.
  constructor(limit = 512) {
    this.limit = limit;
  }

  /** True when `text` differs from what this thread last recorded (or nothing
   * was recorded yet).  Remembers it either way. */
  changed(threadId: string, text: string): boolean {
    const digest = createHash("sha256").update(text).digest("hex");
    const previous = this.seen.get(threadId);
    this.seen.delete(threadId);
    this.seen.set(threadId, digest);
    while (this.seen.size > this.limit) this.seen.delete(this.seen.keys().next().value!);
    return previous !== digest;
  }
}

export interface RecordInjectionDeps {
  publish: (event: RuntimeEvent) => void;
  /** Attach the lightweight refs to the message that started the turn. */
  attach: (refs: ContextInjectionRef[]) => void;
  newId?: () => string;
  now?: () => Date;
}

/** Publish one `context.injected` event per draft and hand the refs to
 * `attach`.  Returns the refs recorded.  Never throws: this describes a turn,
 * it must not be able to fail one. */
export function recordContextInjections(
  deps: RecordInjectionDeps,
  args: { threadId: string; provider: string; providerInstanceId?: string; drafts: readonly InjectionDraft[] },
): ContextInjectionRef[] {
  const refs: ContextInjectionRef[] = [];
  try {
    const newId = deps.newId ?? (() => `ctx-${randomUUID()}`);
    const now = deps.now ?? (() => new Date());
    for (const draft of args.drafts.slice(0, MAX_CONTEXT_INJECTIONS_PER_TURN)) {
      const text = draft.text;
      if (!text.trim()) continue;
      const ref: ContextInjectionRef = {
        id: newId(),
        source: draft.source,
        preview: injectionPreview(text),
        bytes: Buffer.byteLength(text, "utf8"),
      };
      deps.publish({
        eventId: newEventId(),
        provider: args.provider,
        ...(args.providerInstanceId ? { providerInstanceId: args.providerInstanceId } : {}),
        threadId: args.threadId,
        createdAt: now().toISOString(),
        itemId: ref.id,
        type: "context.injected",
        source: ref.source,
        preview: ref.preview,
        bytes: ref.bytes,
        io: { text: boundText(text) },
      });
      refs.push(ref);
    }
    if (refs.length > 0) deps.attach(refs);
  } catch (error) {
    console.error("context-injection: could not record", error);
  }
  return refs;
}

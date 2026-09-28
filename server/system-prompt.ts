// One builder for the system prompt of every turn, so the direct lane and
// the room lane assemble the same shape and every driver receives the same
// two halves.  The builder is pure: the call site reads memory, selects
// skills, resolves computers, and hands in strings.  This module orders
// them, drops the empty ones, measures each section, and splits the prompt
// at the volatile boundary.
//
// The boundary is a property of the section, never of the driver.  A
// section is volatile when its text legitimately differs between two turns
// of one live conversation: memory, because a bot writes MEMORY.md
// mid-conversation; mentions, which describe the message being sent right
// now; skill instructions and playbooks, which are selected by trigger terms
// in the message being sent right now (selectBundledSkills and
// installedPlaybookInstructions both read the current text); the automation
// note, which names what triggered this one turn; outstanding teammate work
// and recent work (upstream sections that BotFleet may adopt later), which
// settle or relabel while the person keeps talking.  Everything else is the
// stable half: the bytes a provider's cached prefix, or a spawned CLI's
// session contract, must keep identical.
//
// Before this split every one of those sections lived inside the single
// system string.  Saving a memory changed that string, which changed the
// Claude driver's spawn contract, which relaunched the CLI, and the
// provider then re-uploaded the entire conversation at the cache-write
// rate.  A tagged teammate did the same on every mention turn.  Ported
// from OpenMausBot `server/system-prompt.ts` (upstream PR #1758).
import { createHash } from "node:crypto";

export interface PromptPart {
  /** Section id.  Membership in VOLATILE_SECTIONS decides the half; a part
   * may also force the volatile half with `volatile: true`. */
  id: string;
  /** Human label for a "what the model sees" preview. */
  label: string;
  text: string;
  volatile?: boolean;
}

export type PromptSection = PromptPart & { bytes: number; volatile: boolean };

export interface BuiltSystemPrompt {
  /** Every non-empty section joined in order: byte-identical to the single
   * string the lanes concatenated before the split existed. */
  text: string;
  /** The stable sections joined in order. */
  stable: string;
  /** The volatile sections joined in order. */
  volatile: string;
  /** sha256 of `volatile`, so a driver can compare halves without hashing
   * the text itself on every turn. */
  volatileDigest: string;
  sections: PromptSection[];
  /** UTF-8 bytes of each half, booked beside the turn's usage. */
  bytes: { stable: number; volatile: number };
}

/** Sections whose text legitimately differs between two turns of one live
 * conversation.  The upstream ids (memory, mentions, outstanding, recent)
 * match so a later port of the outstanding-work and recent-work sections
 * lands on the right half.  `skill-instructions`, `playbooks`, and
 * `automation` are BotFleet's own: each is chosen per message, so keeping
 * them stable would change the stable half — and relaunch the Claude CLI,
 * re-uploading the cached conversation — the first time a message used a
 * new trigger term. */
export const VOLATILE_SECTIONS: ReadonlySet<string> = new Set([
  "memory",
  "mentions",
  "outstanding",
  "recent",
  "skill-instructions",
  "playbooks",
  "automation",
]);

export function isVolatileSection(part: Pick<PromptPart, "id" | "volatile">): boolean {
  return part.volatile === true || VOLATILE_SECTIONS.has(part.id);
}

export function volatileDigest(volatile: string): string {
  return createHash("sha256").update(volatile).digest("hex");
}

export function buildSystemPrompt(parts: readonly PromptPart[]): BuiltSystemPrompt {
  const sections: PromptSection[] = parts
    .filter((part) => part.text.length > 0)
    .map((part) => ({ ...part, bytes: Buffer.byteLength(part.text, "utf8"), volatile: isVolatileSection(part) }));
  const half = (volatile: boolean) =>
    sections.filter((section) => section.volatile === volatile).map((section) => section.text).join("");
  const stable = half(false);
  const volatile = half(true);
  return {
    text: sections.map((section) => section.text).join(""),
    stable,
    volatile,
    volatileDigest: volatileDigest(volatile),
    sections,
    bytes: { stable: Buffer.byteLength(stable, "utf8"), volatile: Buffer.byteLength(volatile, "utf8") },
  };
}

/** The owner's standing notes for a bot, as a system-prompt section.
 *
 *  `userNotes` is documented on the record as "Custom user-provided
 *  instructions and persistent memory notes"; the API accepts it, settings
 *  offers it, and it round-trips through every save.  Nothing read it.  It was
 *  a field a person could fill in expecting their bot to know, with no way to
 *  find out that it did not, and eleven of twelve live bots had it empty —
 *  which is what an ignored field looks like from the data side.
 *
 *  Its own section rather than folded into `memory`: MEMORY.md is something
 *  the bot wrote itself, this is something the owner wrote.  Merging them
 *  would let a bot "correct" the owner's own words, so the copy says plainly
 *  that it may not.  Owner-authored also means it outranks recalled material,
 *  webhook payloads and peer messages, which is the precedence the rest of the
 *  prompt already assumes for the owner's own configuration.
 *
 *  Left in the STABLE half (it is not in `VOLATILE_SECTIONS`, and the part
 *  does not force the volatile flag).  Owner notes change rarely, so they
 *  belong in the provider-cacheable prefix; editing them in Settings
 *  invalidates that prefix once, which is the correct cost for a real change.
 *  Both halves are re-sent every turn, so the edit still lands on the next
 *  message either way — volatile would only buy a permanently uncached
 *  section.  Contrast `memory`, which is volatile because a bot rewrites its
 *  own MEMORY.md mid-conversation. */
export function ownerNotesPrompt(notes: string | undefined | null): string {
  const text = (notes ?? "").trim();
  if (!text) return "";
  return (
    "\n\nStanding notes from your owner for this bot. The owner wrote these for you directly, and they" +
    " outrank anything you recall, anything a webhook delivered, and anything another bot told you." +
    " Unlike your own MEMORY.md, you did not write these: do not edit them, and do not decide they are" +
    " wrong.\n\n" +
    text
  );
}

// Grouping a transcript's tool chips into runs.
//
// A bot working through a task emits one chip per tool call, and a long
// stretch of them buries the thing you actually came to read: what the bot
// SAID. Consecutive finished steps fold into a single row that names them;
// text between two stretches breaks the run, so the bot's words always
// separate one run from the next.
import type { Message } from "@/state/store";
import { classifyTool, toolVerb } from "../../shared/tool-activity";

export type TranscriptItem =
  | { kind: "message"; message: Message }
  | { kind: "run"; id: string; messages: Message[] };

/** A step that may be folded away: finished, a real tool, and not a
 * bot⇄bot chip (those are navigation, not work) or a failed turn (that
 * renders as an error). A step still running stays out, so live progress
 * is never hidden behind a fold. */
function foldable(message: Message): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm) return false;
  if (tool.ok !== true) return false;
  return !tool.name.startsWith("error:");
}

/** Move each helper step (a row whose tool names a `parentItemId`) to sit
 * right under the row that started the helper, after that helper's earlier
 * steps.  Parallel helpers otherwise interleave their steps with each other
 * and with the bot's own, and nothing says which helper did what.  A step
 * whose parent row is not in the list (an older transcript, a trimmed
 * window) stays where it was.  Order is otherwise untouched, and a list with
 * no helper steps comes back as the same array. */
export function nestHelperSteps(messages: Message[]): Message[] {
  const parentIds = new Set<string>();
  for (const message of messages) {
    const itemId = message.kind === "activity" ? message.tool?.itemId : undefined;
    if (itemId) parentIds.add(itemId);
  }
  const nested = new Map<string, Message[]>();
  for (const message of messages) {
    const parent = message.tool?.parentItemId;
    if (!parent || !parentIds.has(parent)) continue;
    const children = nested.get(parent) ?? [];
    children.push(message);
    nested.set(parent, children);
  }
  if (nested.size === 0) return messages;
  const ordered: Message[] = [];
  const placed = new Set<Message>();
  const place = (message: Message) => {
    if (placed.has(message)) return;
    placed.add(message);
    ordered.push(message);
    const itemId = message.kind === "activity" ? message.tool?.itemId : undefined;
    // depth is one level today (helpers cannot spawn helpers), but a nested
    // helper would still land under its own parent
    for (const child of (itemId && nested.get(itemId)) || []) place(child);
  };
  for (const message of messages) {
    const parent = message.tool?.parentItemId;
    if (parent && parentIds.has(parent)) continue;
    place(message);
  }
  // A malformed chain (a row naming itself, or two naming each other) has no
  // root to hang from: keep those rows rather than lose them.
  for (const message of messages) place(message);
  return ordered;
}

/** Runs shorter than this stay unfolded.
 *
 * A step is one line now, so five of them cost less vertical space than the
 * fold that would hide them — and a reader who can see "Read · config.ts,
 * Read · store.ts" does not have to click to learn the turn was working
 * through the codebase.  Folding earns its place only when a run is long
 * enough to bury the bot's words. */
export const RUN_FOLD_MIN = 6;

export function groupActivityRuns(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: Message[] = [];
  const flush = () => {
    // a short run is cheaper to read than a fold that hides it
    if (run.length >= RUN_FOLD_MIN) items.push({ kind: "run", id: `run:${run[0].id}`, messages: run });
    else for (const message of run) items.push({ kind: "message", message });
    run = [];
  };
  for (const message of messages) {
    if (foldable(message)) {
      const first = run[0];
      if (
        first &&
        (first.role !== message.role ||
          first.from?.botId !== message.from?.botId ||
          new Date(first.at).toDateString() !== new Date(message.at).toDateString())
      ) {
        flush();
      }
      run.push(message);
      continue;
    }
    flush();
    items.push({ kind: "message", message });
  }
  flush();
  return items;
}

const MAX_NAMES = 3;
const MAX_TARGETS = 2;

/** The one line a folded run has to earn its place with: how much work it
 * was, which tools did it, and whether anything failed — the last being the
 * only reason you would open it. */
export function describeRun(messages: Message[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const tool = message.tool;
    // classify here too, so a fold header names the work the same way the
    // rows inside it do — including for steps recorded before the harness
    // started reporting a kind
    const label = tool ? toolVerb(tool.kind ?? classifyTool(tool.name), tool.name) : "";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const rest = names.length > MAX_NAMES ? ` +${names.length - MAX_NAMES} more` : "";
  const failed = messages.filter((message) => message.tool?.ok === false).length;
  // naming what it touched is the difference between "7 steps" and "7 steps
  // through the driver files" — the second one a reader can skip on purpose
  const targets = [
    ...new Set(messages.flatMap((message) => (message.tool?.target ? [message.tool.target] : []))),
  ];
  const where = targets.length
    ? ` — ${targets.slice(0, MAX_TARGETS).map(basename).join(", ")}${
        targets.length > MAX_TARGETS ? ` +${targets.length - MAX_TARGETS}` : ""
      }`
    : "";
  return `${messages.length} steps · ${shown}${rest}${where}${failed ? ` · ${failed} failed` : ""}`;
}

/** Last path segment, for a fold header that has room for two of them. */
function basename(value: string): string {
  const path = value.split(/[?#]/)[0] ?? value;
  const parts = path.split(/[/\\]/).filter(Boolean);
  const last = parts.at(-1) ?? value;
  return last.length > 28 ? last.slice(0, 27) + "…" : last;
}

// What the harness put in front of the model that the person did not type.
//
// One quiet row per injection, under the message that started the turn:
//
//   ◦ Context injection · memory   likes tea and quiet          412 B  ›
//
// It is deliberately the dimmest thing in the transcript.  The bot's words and
// the work it did are what a reader came for; this is the footnote that
// explains why the bot behaved as it did — the memory it was handed, the skill
// a word in the message triggered, the conversation replayed to it when it
// joined mid-thread.  Closed it costs one line; opened it shows the full text
// the model was given, fetched from the harness only then.
//
// `ContextInjectionRow` is the renderer (what the tests render);
// `ContextInjectionRows` lays out a message's list.
import { useState } from "react";
import {
  ArrowRightLeft,
  AtSign,
  Brain,
  ChevronDown,
  ChevronRight,
  Clock,
  ListChecks,
  Quote,
  RotateCcw,
  Wand2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import type { ItemIoRef } from "@/lib/item-io";
import {
  contextInjectionLabel,
  formatContextBytes,
  type ContextInjectionRef,
  type ContextSource,
} from "../../shared/context-injection";
import { ItemIoBlocks, useItemIo } from "./ItemIoBlocks";

const ICONS: Record<ContextSource, LucideIcon> = {
  memory: Brain,
  skill: Wand2,
  playbook: ListChecks,
  automation: Clock,
  mention: AtSign,
  handoff: ArrowRightLeft,
  rewind: RotateCcw,
  reply: Quote,
};

/** A plain-words line for what each source is, shown when a row is opened. */
const EXPLANATION: Record<ContextSource, string> = {
  memory: "The bot's own MEMORY.md, added to its prompt.",
  skill: "Skill instructions a word in your message selected.",
  playbook: "Installed playbook instructions your message selected.",
  automation: "The note naming which automation started this turn.",
  mention: "A nudge to bring in the teammate you tagged.",
  handoff: "The conversation so far, replayed because this engine joined mid-thread.",
  rewind: "The surviving conversation, replayed after an edit or a version switch.",
  reply: "The earlier message your reply quotes.",
};

export function ContextInjectionRow({
  entry,
  threadId,
  defaultOpen = false,
}: {
  entry: ContextInjectionRef;
  threadId: string;
  /** Start opened.  The chat never passes this; tests render the open row. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ref: ItemIoRef = { threadId, itemId: entry.id };
  const io = useItemIo(ref, open);
  const Icon = ICONS[entry.source];
  const label = contextInjectionLabel(entry.source);
  const size = formatContextBytes(entry.bytes);
  const detailId = `context-${entry.id}`;

  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        title={entry.preview ? `${label} · ${entry.preview}` : label}
        className={cn(
          "group/context flex w-full items-baseline gap-2 rounded-md px-1.5 py-[2px] text-left text-[12px] leading-6",
          "text-ink-secondary/70 hover:bg-raised/60 hover:text-ink-secondary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        )}
      >
        <span className="flex size-4 shrink-0 translate-y-[3px] items-center justify-center">
          <Icon size={12} aria-hidden="true" />
        </span>
        <span className="shrink-0 font-medium">{label}</span>
        {entry.preview && <span className="min-w-0 flex-1 truncate">{entry.preview}</span>}
        {!entry.preview && <span className="flex-1" />}
        {size && <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-secondary/50">{size}</span>}
        <span
          className={cn(
            "shrink-0 text-ink-secondary/50 transition-opacity",
            open ? "opacity-100" : "opacity-40 group-hover/context:opacity-100",
          )}
          aria-hidden="true"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {open && (
        <div
          id={detailId}
          className="mb-1 ml-7 flex max-h-[32rem] flex-col gap-1.5 overflow-auto rounded-lg border border-hairline/40 bg-panel/70 p-2.5"
        >
          <p className="text-[11px] text-ink-secondary">{EXPLANATION[entry.source]}</p>
          <ItemIoBlocks
            state={io.state}
            onRetry={io.retry}
            fallback={
              entry.preview ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-secondary select-text">
                  {entry.preview}
                </pre>
              ) : null
            }
          />
        </div>
      )}
    </div>
  );
}

/** A message's injections, in the order the harness added them. */
export function ContextInjectionRows({
  entries,
  threadId,
}: {
  entries: readonly ContextInjectionRef[] | undefined;
  threadId: string;
}) {
  if (!entries || entries.length === 0) return null;
  return (
    <div className="flex w-full flex-col" role="group" aria-label="Context injected into this turn">
      {entries.map((entry) => (
        <ContextInjectionRow key={entry.id} entry={entry} threadId={threadId} />
      ))}
    </div>
  );
}

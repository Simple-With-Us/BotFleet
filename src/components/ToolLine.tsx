// One step, one line: what the bot did and what it did it to.
//
// The old chip was a bordered card holding a bare tool name, so a turn that
// read seven files rendered seven identical `read_file` boxes — a hundred and
// fifty pixels of chrome carrying no information.  A step is a log line, not
// a message: it gets a glyph, a verb, the thing it touched, and how long it
// took, on one row at the transcript's left margin.  The bot's own words keep
// the bubbles; the work underneath them reads like a file listing.
//
// Failures are the exception that earns weight.  A failed step is the only
// row a reader opens on purpose, so it stays red and shows its message
// without being asked.
import { useState } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { classifyTool, toolVerb, type ToolKind } from "../../shared/tool-activity";
import type { Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { itemIoRefOf } from "@/lib/item-io";
import { ItemIoBlocks, useItemIo } from "./ItemIoBlocks";

const ICONS: Record<ToolKind, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  execute: Terminal,
  search: Search,
  fetch: Globe,
  think: Sparkles,
  task: Wrench,
  notice: RefreshCw,
  other: Wrench,
};

/** `1400` → `1.4s`; anything under a second is noise on a row this dense. */
export function formatStepDuration(ms: number | undefined): string | null {
  if (!ms || ms < 1000) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

export function ToolLine({
  message,
  actor,
  threadId,
  defaultOpen = false,
}: {
  message: Message;
  actor?: string;
  /** The thread this row belongs to.  With it, opening the row reads the
   * step's full input and output from the harness; without it (a view that
   * does not know its thread) the row shows the headline it has always shown. */
  threadId?: string;
  /** Start opened.  The chat never passes this; tests render the open row. */
  defaultOpen?: boolean;
}) {
  const tool = message.tool;
  const [open, setOpen] = useState(defaultOpen);
  // The step's key in the harness's side store.  Null for a row recorded before
  // the harness kept one, which then says so when opened.
  const ioRef = itemIoRefOf(threadId, tool);
  // A step still running has written no output yet: show what is there, keep nothing.
  const io = useItemIo(ioRef, open, tool?.ok !== undefined);
  if (!tool) return null;

  const running = tool.ok === undefined;
  const failed = tool.ok === false;
  // Steps recorded before the harness classified them — every message
  // already in a transcript — still get the right glyph and verb: the name
  // is all the classifier needs, and it is the same table the server uses.
  const kind: ToolKind = tool.kind ?? classifyTool(tool.name);
  const Icon = ICONS[kind];
  const verb = toolVerb(kind, tool.name);
  // What the row says after the verb, in order of what a reader wants: why
  // it failed, what it touched, or — when the verb is a generic one and
  // nothing else is known — the engine's own name for the tool, so the row
  // still identifies it.  Never the name twice.
  const named = verb !== tool.name ? tool.name : undefined;
  const line = failed ? (tool.detail ?? tool.target ?? named) : (tool.target ?? named);
  const duration = formatStepDuration(tool.durationMs);
  // Expandable whenever there is detail OR a target (like a command or file path) to view,
  // or the harness may hold the step's whole input and output
  const hasTarget = Boolean(tool.target && tool.target !== tool.name);
  const hasDetail = Boolean(tool.detail);
  const expandable = hasDetail || hasTarget || ioRef !== null;
  const time = new Date(message.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const title = `${actor ? `${actor} · ` : ""}${tool.name}${
    tool.target ? ` · ${tool.target}` : ""
  } · ${time}${failed ? " · failed" : running ? " · running" : ""}`;

  // The clipped headline the row has always had: what the step acted on and
  // one line of what came back.  The fallback whenever the full payload is not
  // there, and the whole of it for a row with no key.
  const targetBlock = tool.target ? (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-secondary/70">
        {kind === "execute" ? "Command" : kind === "read" || kind === "edit" ? "File" : "Target"}
      </span>
      <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink font-medium select-text">
        {tool.target}
      </pre>
    </div>
  ) : null;
  const detailBlock = tool.detail ? (
    <div className="flex flex-col gap-0.5">
      {tool.target && (
        <span className={cn("text-[10px] font-semibold uppercase tracking-wider", failed ? "text-danger/90" : "text-ink-secondary/70")}>
          {failed ? "Error Details" : "Output"}
        </span>
      )}
      <pre className={cn("whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed select-text", failed ? "text-danger" : "text-ink-secondary")}>
        {tool.detail}
      </pre>
    </div>
  ) : null;

  return (
    <div className="flex w-full flex-col">
      <div
        className={cn(
          "group/step flex w-full items-baseline gap-2 rounded-md px-1.5 py-[3px] text-[13px] leading-6",
          "hover:bg-raised/60",
          failed ? "text-danger" : "text-ink-secondary",
        )}
        title={title}
      >
        <span className="flex size-4 shrink-0 translate-y-[3px] items-center justify-center">
          {running ? (
            <Loader2 size={13} className="animate-spin text-accent" />
          ) : failed ? (
            <AlertCircle size={13} className="text-danger" />
          ) : (
            <Icon size={13} className="text-ink-secondary/70" />
          )}
        </span>
        <button
          type="button"
          onClick={expandable ? () => setOpen((value) => !value) : undefined}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          className={cn(
            "flex min-w-0 flex-1 items-baseline gap-2 text-left",
            expandable ? "cursor-pointer" : "cursor-default",
          )}
        >
          {verb && <span className={cn("shrink-0 font-medium", failed ? "text-danger" : "text-ink")}>{verb}</span>}
          {line && (
            <>
              {verb && <span className="shrink-0 text-ink-secondary/50">·</span>}
              <span
                className={cn(
                  "min-w-0 truncate",
                  failed ? "text-danger" : "select-text text-ink-secondary",
                  !failed && (kind === "read" || kind === "edit" || kind === "execute") && "font-mono text-[12px]",
                )}
                // A failed step clips its reason to one line, and one with
                // no target has no disclosure triangle either — so the reason
                // rides the hover.  A step that did not fail says nothing the
                // row's own title does not already say in full, and shadowing
                // it there would lose the tool name and the time.
                title={failed ? line : undefined}
              >
                {line}
              </span>
            </>
          )}
          {expandable && (
            <span
              className={cn(
                "shrink-0 text-ink-secondary/50 transition-opacity",
                open ? "opacity-100" : "opacity-40 group-hover/step:opacity-100",
              )}
            >
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </button>
        {duration && (
          <span className="shrink-0 font-mono text-[11px] text-ink-secondary/50 tabular-nums">{duration}</span>
        )}
      </div>
      {open && (
        <div
          className={cn(
            "mb-1 ml-7 flex flex-col gap-1.5 overflow-auto rounded-lg border border-hairline/40 bg-panel/70 p-2.5",
            ioRef ? "max-h-[32rem]" : "max-h-64",
          )}
        >
          {threadId ? (
            <ItemIoBlocks
              state={ioRef ? io.state : { status: "unavailable" }}
              failed={failed}
              onRetry={io.retry}
              fallback={
                <>
                  {targetBlock}
                  {detailBlock}
                </>
              }
              outputFallback={detailBlock}
            />
          ) : (
            <>
              {targetBlock}
              {detailBlock}
            </>
          )}
        </div>
      )}
    </div>
  );
}

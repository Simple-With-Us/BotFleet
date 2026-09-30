// A step's full input and output, as two labelled blocks.
//
// Used wherever a step opens: a tool row in the chat (ToolLine), a step in the
// Trajectory list (TrajectoryRows), and the text an injected-context row
// carries (ContextInjectionRows).  The blocks are the same everywhere because
// the question is the same: what exactly went in, and what exactly came back.
//
// `ItemIoBlocks` is the pure renderer: a state in, markup out, which is what
// the tests render.  `useItemIo` owns the asking.  A row always renders
// something useful while the full payload is not there (the clipped headline it
// already had) and says plainly which of the four situations it is in:
// loading, loaded, never recorded, or failed to load.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/lib/cn";
import {
  loadItemIo,
  peekItemIo,
  truncationNote,
  type ItemIoRef,
  type ItemIoState,
} from "@/lib/item-io";
import type { BoundedText } from "../../shared/item-io";

/** The sentence a row shows when nothing was recorded for its step. */
export const ITEM_IO_UNAVAILABLE = "Full input and output weren't recorded for this step.";
export const ITEM_IO_LOADING = "Loading the full input and output…";
export const ITEM_IO_ERROR = "Couldn't load the full input and output.";

/** Ask for a step's input and output once it is wanted.
 *
 * Starts from whatever is already cached, so a row opened twice renders its
 * blocks on the first frame.  `enabled` is false while the row is closed —
 * nothing is requested for a row nobody opened.  `settled` is false for a step
 * still running: its output has not been written yet, so the answer is shown
 * but not kept. */
export function useItemIo(
  ref: ItemIoRef | null,
  enabled: boolean,
  settled = true,
): { state: ItemIoState; retry: () => void } {
  const threadId = ref?.threadId;
  const itemId = ref?.itemId;
  const turnId = ref?.turnId;
  const [state, setState] = useState<ItemIoState>(() => (ref ? (peekItemIo(ref) ?? { status: "loading" }) : { status: "unavailable" }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled || !threadId || !itemId) return;
    const key: ItemIoRef = { threadId, itemId, ...(turnId ? { turnId } : {}) };
    const known = settled ? peekItemIo(key) : undefined;
    if (known) {
      setState(known);
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    void loadItemIo(key, { cache: settled, signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, [enabled, threadId, itemId, turnId, settled, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (!ref) return { state: { status: "unavailable" }, retry };
  return { state, retry };
}

function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      // a blocked clipboard is not worth an error row; the text is on screen
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium",
        "text-ink-secondary hover:bg-raised hover:text-ink",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
        copied && "text-success hover:text-success",
      )}
    >
      {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/** One labelled, scrollable, copyable block of captured text. */
export function IoBlock({
  label,
  field,
  tone = "normal",
  className,
}: {
  label: string;
  field: BoundedText;
  tone?: "normal" | "danger";
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)} data-io={label.toLowerCase()}>
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wider",
            tone === "danger" ? "text-danger/90" : "text-ink-secondary/70",
          )}
        >
          {label}
        </span>
        <CopyTextButton text={field.text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre
        tabIndex={0}
        aria-label={label}
        className={cn(
          "max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-inset px-2 py-1.5",
          "font-mono text-[11.5px] leading-relaxed select-text",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
          tone === "danger" ? "text-danger" : "text-ink",
        )}
      >
        {field.text}
      </pre>
      {field.truncated && <p className="text-[10.5px] text-ink-secondary">{truncationNote(field)}</p>}
    </div>
  );
}

/** The four situations of a step's full payload. */
export function ItemIoBlocks({
  state,
  failed = false,
  fallback,
  outputFallback,
  onRetry,
}: {
  state: ItemIoState;
  /** the step failed: its output block is labelled, and coloured, as an error */
  failed?: boolean;
  /** the clipped headline the row already had, shown whenever the full
   * payload is not (yet) there */
  fallback?: ReactNode;
  /** the clipped result line, shown under a loaded input when no output was
   * recorded for the step */
  outputFallback?: ReactNode;
  onRetry?: () => void;
}) {
  if (state.status === "loaded") {
    const { input, output, text } = state.io;
    if (input || output || text) {
      return (
        <>
          {input && <IoBlock label="IN" field={input} />}
          {output ? <IoBlock label={failed ? "ERROR" : "OUT"} field={output} tone={failed ? "danger" : "normal"} /> : outputFallback}
          {/* the full text of an injected-context record, which has no IN or OUT */}
          {text && <IoBlock label="Text" field={text} />}
        </>
      );
    }
  }
  return (
    <>
      {fallback}
      {state.status === "loading" && (
        <p role="status" aria-live="polite" className="text-[11px] text-ink-secondary">
          {ITEM_IO_LOADING}
        </p>
      )}
      {(state.status === "unavailable" || state.status === "loaded") && (
        <p className="text-[11px] text-ink-secondary">{ITEM_IO_UNAVAILABLE}</p>
      )}
      {state.status === "error" && (
        <p className="flex items-center gap-2 text-[11px] text-ink-secondary">
          <span title={state.message}>{ITEM_IO_ERROR}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="rounded px-1.5 py-0.5 font-medium text-accent-text hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              Retry
            </button>
          )}
        </p>
      )}
    </>
  );
}

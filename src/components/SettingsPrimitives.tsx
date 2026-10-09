import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

export function Card({
  title,
  subtitle,
  actions,
  children,
  id,
  className,
}: {
  title?: string;
  subtitle?: React.ReactNode;
  /** Optional right-aligned control area on the header row — used by the
   *  Usage card's "Expand all / Collapse all" toggle.  Slot comes AFTER
   *  title+subtitle so wrapping a long subtitle never pushes the button
   *  off-screen. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <div id={id} className={className ? cn("rounded-xl bg-card p-4", className) : "rounded-xl bg-card p-4"}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {title && <div className="text-[15px] font-medium text-ink">{title}</div>}
            {subtitle && <div className={title ? "mt-0.5 text-[13px] leading-relaxed text-ink-secondary" : "text-[13px] leading-relaxed text-ink-secondary"}>{subtitle}</div>}
          </div>
          {actions && <div className="shrink-0 pt-0.5">{actions}</div>}
        </div>
      )}
      {children && <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>}
    </div>
  );
}

/** A command the user is meant to run, with one-click copy. */
export function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission can be denied; leave the button unchanged */
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink">
        {command}
      </code>
      <button
        onClick={() => void copy()}
        aria-label="Copy Command"
        className="shrink-0 rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

/** A readable value the user can copy in one click.  Always shown in full. */
export function CopyableValue({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission can be denied; leave the button unchanged */
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-hairline/50 bg-control px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-ink-secondary">{label}</div>
        <div
          className="mt-0.5 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-ink"
          title={value}
          data-testid="copyable-value"
        >
          {value}
        </div>
      </div>
      <button
        onClick={() => void copy()}
        aria-label={`Copy ${label}`}
        className="shrink-0 rounded px-2 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

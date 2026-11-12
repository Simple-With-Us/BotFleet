// The per-conversation context meter, the compact action, and the one-time
// note.  Numbers come from deriveContextMeter.  This file only draws them.
import { useEffect, useRef, useState } from "react";
import {
  COMPACT_SESSION_LABEL,
  CONTEXT_NOTE_TEXT,
  compactOffer,
  deriveContextMeter,
  nextContextNote,
  type CompactCommand,
  type CompactOffer,
  type ContextMeter,
  type ContextNoteMemory,
} from "../../shared/context-meter.ts";
import { fetchBotCommands, runBotCommand } from "@/lib/bot-commands-client";

const BUSY_REASON = "Still working.\u00A0 Let this reply finish first.";
const OTHER_THREAD_REASON = "Switch to this conversation before compacting it.";

export function contextMeterFor(input: {
  used?: number | null;
  reportedWindow?: number | null;
  catalogWindow?: number | null;
}): ContextMeter {
  return deriveContextMeter(input);
}

export function ContextFillBadge({ meter }: { meter: ContextMeter }) {
  if (meter.percent === null) return null;
  const high = meter.percent >= 80;
  return (
    <span
      title={meter.detail}
      className={
        high
          ? "shrink-0 rounded-full bg-warning/15 px-1.5 py-0 text-[10px] font-medium tabular-nums text-warning"
          : "shrink-0 rounded-full bg-raised px-1.5 py-0 text-[10px] font-medium tabular-nums text-ink-secondary"
      }
    >
      {meter.percent}%
    </span>
  );
}

export function CompactSessionRow({ settled }: { settled: boolean }) {
  return (
    <div className="flex justify-center">
      <p className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary">
        {settled ? "Compacted this session." : "Compacting this session."}
      </p>
    </div>
  );
}

export function ContextNote({
  pending,
  disabledReason,
  onCompact,
}: {
  pending: boolean;
  disabledReason: string | null;
  onCompact: () => void;
}) {
  return (
    <div className="flex justify-center px-4" data-context-note="once">
      <p className="max-w-xl text-center text-[13px] leading-relaxed text-ink-secondary">
        {CONTEXT_NOTE_TEXT}{" "}
        <button
          type="button"
          onClick={onCompact}
          disabled={pending || disabledReason !== null}
          title={disabledReason ?? undefined}
          className="font-medium text-accent underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-ink-secondary disabled:no-underline"
        >
          {COMPACT_SESSION_LABEL}
        </button>
      </p>
    </div>
  );
}

function MeterBar({ meter }: { meter: ContextMeter }) {
  if (meter.bar === null || meter.percentLabel === null) {
    return (
      <p className="text-[12px] text-ink-secondary" title={meter.detail}>
        {meter.summary}
      </p>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2" title={meter.detail}>
      <div
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={meter.bar}
        aria-valuetext={meter.percentLabel}
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-raised"
      >
        <div
          className={meter.percent !== null && meter.percent >= 80 ? "h-full bg-warning" : "h-full bg-accent"}
          style={{ width: `${meter.bar}%` }}
        />
      </div>
      <span className="whitespace-nowrap text-[12px] tabular-nums text-ink-secondary">
        <span className="font-medium text-ink">{meter.percentLabel}</span>
        <span>{` · ${meter.summary}`}</span>
      </span>
    </div>
  );
}

function compactCommands(menu: Awaited<ReturnType<typeof fetchBotCommands>>): CompactCommand[] | null {
  if (!menu) return null;
  const commands: CompactCommand[] = [];
  for (const group of menu.groups) {
    for (const command of group.commands) {
      commands.push({
        id: command.id,
        name: command.name,
        enabled: command.enabled,
        disabledReason: command.disabledReason,
      });
    }
  }
  return commands;
}

export function useContextSession(input: {
  botId: string;
  threadId: string;
  used?: number | null;
  window?: number | null;
  busy: boolean;
  viewingOther: boolean;
}) {
  const [menu, setMenu] = useState<CompactCommand[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const memoryRef = useRef<Map<string, ContextNoteMemory | null>>(new Map());
  const offer: CompactOffer = compactOffer(menu);
  let shown: CompactOffer = offer;
  if (input.viewingOther) shown = { state: "disabled", reason: OTHER_THREAD_REASON };
  else if (input.busy && offer.state === "ready") shown = { state: "disabled", reason: BUSY_REASON };

  useEffect(() => {
    setMenu(null);
  }, [input.botId, input.threadId]);

  useEffect(() => {
    const botId = input.botId;
    const threadId = input.threadId;
    let cancelled = false;
    void fetchBotCommands(botId, threadId)
      .then((response) => {
        if (!cancelled) setMenu(compactCommands(response));
      })
      .catch(() => {
        if (!cancelled) setMenu(null);
      });
    return () => {
      cancelled = true;
    };
  }, [input.botId, input.threadId, input.busy]);

  const compactReady = offer.state === "ready" && !input.viewingOther;
  const memory = memoryRef.current.get(input.threadId) ?? null;
  const note = nextContextNote({
    used: input.used ?? null,
    window: input.window ?? null,
    compactReady,
    memory,
  });
  useEffect(() => {
    memoryRef.current.set(input.threadId, note.memory);
  }, [input.threadId, note.memory]);

  const compact = () => {
    if (shown.state !== "ready" || pending) return;
    const commandId = shown.commandId;
    setPending(true);
    setError(null);
    void runBotCommand(input.botId, { id: commandId, threadId: input.threadId }).then((result) => {
      setPending(false);
      if (!result.ok) setError(result.error);
    }).catch(() => {
      setPending(false);
      setError("That did not start.");
    });
  };

  return { offer: shown, note, pending, error, compact };
}

export function ContextUsageStrip({
  meter,
  offer,
  pending,
  error,
  onCompact,
}: {
  meter: ContextMeter;
  offer: CompactOffer;
  pending: boolean;
  error: string | null;
  onCompact: () => void;
}) {
  return (
    <div className="pointer-events-auto flex w-full flex-wrap items-center gap-x-3 gap-y-1 bg-app px-6 pb-1">
      <MeterBar meter={meter} />
      {offer.state === "ready" ? (
        <button
          type="button"
          onClick={onCompact}
          disabled={pending}
          className="rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-0.5 text-[12px] text-ink hover:bg-raised disabled:opacity-50"
        >
          {pending ? "Compacting…" : COMPACT_SESSION_LABEL}
        </button>
      ) : null}
      {offer.state === "disabled" ? (
        <button
          type="button"
          disabled
          title={offer.reason}
          className="cursor-not-allowed rounded-full border border-hairline/30 px-2.5 py-0.5 text-[12px] text-ink-secondary opacity-60"
        >
          {COMPACT_SESSION_LABEL}
        </button>
      ) : null}
      {error ? <p className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}

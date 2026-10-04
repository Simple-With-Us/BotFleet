import { useEffect, useRef, useState } from "react";
import { InstanceInfo } from "@/state/store";

import { AlertTriangle, Bug, RefreshCw, Play, Send, Zap, RotateCcw, Download, Terminal, Laptop, Monitor } from "lucide-react";

import { EngineSetup } from "./EngineSetup";
import { openSentryFeedback } from "@/lib/sentry";

export const ERROR_RECOVERY_EVENT = "omb-error-recovery";

/**
 * Ensures two visible spaces between sentences in rendered HTML/JSX copy.
 * Only horizontal whitespace is replaced, so a line break after punctuation
 * stays a line break instead of becoming a single gap.
 */
export function formatSentenceGap(text: string): string {
  if (!text) return "";
  return text.replace(/([.!?])[^\S\r\n\u2028\u2029]+(?=[A-Z0-9"'])/g, "$1\u00A0 ");
}

export type ErrorRecoveryAction =
  | "switch-model"
  | "add-key"
  | "open-computer"
  | "use-this-computer"
  | "create-local-vm";

export type ErrorRecoveryDetail = {
  action: ErrorRecoveryAction;
  botId?: string;
};

export function requestErrorRecovery(action: ErrorRecoveryAction, botId?: string): void {
  window.dispatchEvent(new CustomEvent(ERROR_RECOVERY_EVENT, { detail: { action, botId } satisfies ErrorRecoveryDetail }));
}

export function isComputerDispatchError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("computer tool failed") ||
    lower.includes("no computer") ||
    lower.includes("local vm") ||
    lower.includes("this computer") ||
    lower.includes("desktop failed") ||
    lower.includes("provision")
  );
}

export function isProviderError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("provider") ||
    lower.includes("api key") ||
    lower.includes("rate limit") ||
    lower.includes("model")
  );
}

type TurnErrorMessage = {
  id: string;
  kind: string;
  tool?: { name: string };
};

type BranchMessage = TurnErrorMessage & {
  role: string;
  parentId?: string | null;
};

function turnErrorText(message: TurnErrorMessage | undefined): string | null {
  if (message?.kind !== "activity" || !message.tool?.name.startsWith("error:")) return null;
  return message.tool.name.slice(6).trim();
}

export function latestTurnErrorMessage<T extends TurnErrorMessage>(messages: readonly T[]): T | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (turnErrorText(message)) return message;
  }
  return undefined;
}

/** Identity of the selected forks, stable while new messages append to the
 * same path.  A live region can key on this without silencing new errors. */
export function turnErrorBranchKey(allMessages: readonly BranchMessage[], visibleMessages: readonly BranchMessage[]): string {
  const siblings = new Map<string, number>();
  const siblingKey = (message: BranchMessage) => `${message.role}\0${message.kind}\0${message.parentId ?? ""}`;
  for (const message of allMessages) {
    if ((message.role !== "user" && message.role !== "system") || message.kind !== "text") continue;
    const key = siblingKey(message);
    siblings.set(key, (siblings.get(key) ?? 0) + 1);
  }
  return visibleMessages
    .filter((message) => (siblings.get(siblingKey(message)) ?? 0) > 1)
    .map((message) => message.id)
    .join("\0");
}

function turnErrorSignature(message: TurnErrorMessage | undefined): string {
  return message ? `${message.id}\0${turnErrorText(message) ?? ""}` : "";
}

export function nextTurnErrorAnnouncement(
  previousSignature: string,
  latestMessage: TurnErrorMessage | undefined,
  stream?: { previousTailId: string | undefined; currentTailId: string | undefined },
): { signature: string; text: string | null } {
  const signature = turnErrorSignature(latestMessage);
  return {
    signature,
    // Loading an older page changes the newest known error without changing
    // the stream tail.  Keep that historical row out of the live region.
    text: signature !== previousSignature && (!stream || stream.currentTailId !== stream.previousTailId)
      ? turnErrorText(latestMessage)
      : null,
  };
}

export type TurnErrorLiveState = { text: string; nonce: number };

export function advanceTurnErrorLiveState(
  previous: TurnErrorLiveState,
  text: string,
): TurnErrorLiveState {
  return { text, nonce: previous.nonce + 1 };
}

export function TurnErrorAnnouncement({
  latestMessage,
  streamTailId,
}: {
  latestMessage: TurnErrorMessage | undefined;
  streamTailId?: string;
}) {
  const initialSignature = turnErrorSignature(latestMessage);
  const previousSignature = useRef(initialSignature);
  const previousTailId = useRef(streamTailId);
  const [announcement, setAnnouncement] = useState<TurnErrorLiveState>({ text: "", nonce: 0 });

  useEffect(() => {
    const next = nextTurnErrorAnnouncement(previousSignature.current, latestMessage, {
      previousTailId: previousTailId.current,
      currentTailId: streamTailId,
    });
    previousSignature.current = next.signature;
    previousTailId.current = streamTailId;
    const text = next.text;
    if (text) setAnnouncement((previous) => advanceTurnErrorLiveState(previous, text));
  }, [latestMessage?.id, latestMessage?.tool?.name, streamTailId]);

  return (
    <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
      <span key={announcement.nonce}>{announcement.text}</span>
    </div>
  );
}

function RecoveryButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof RefreshCw;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
    >
      <Icon size={12} /> {label}
    </button>
  );
}

/** The driver label that goes into a report's synthetic diagnostics block:
 * display name where there is one, the driver kind otherwise, plus the
 * engine's own version when it reported one.  All three are build metadata,
 * so this is safe to attach to an issue filed against a public repository. */
export function engineLabel(instance: InstanceInfo | undefined): string | undefined {
  if (!instance) return undefined;
  const name = instance.displayName?.trim() || instance.instanceId?.trim() || instance.driverKind?.trim();
  if (!name) return undefined;
  const version = instance.snapshot?.version?.trim();
  return version ? `${name} ${version}` : name;
}

function ReportProblemButton({ message, engine }: { message: string; engine?: string }) {
  return (
    <button
      type="button"
      onClick={() => void openSentryFeedback({
        formTitle: "Report a Problem",
        defaultMessage: `Error encountered: ${message}\n\n`,
        engine,
      })}
      className="flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
      title="Report this problem"
    >
      <Bug size={12} /> Report Problem
    </button>
  );
}

/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal. */
function ErrorRow({
  message,
  onRetry,
  setupInstance,
  botId,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
  botId?: string;
}) {
  return (
    <div className="flex justify-start" aria-live="off">
      <div className="w-fit max-w-[min(42rem,78%)] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap break-words">{formatSentenceGap(message)}</span>
        </div>
        {setupInstance && !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <div className="mt-2 flex flex-col gap-2">
            <EngineSetup instance={setupInstance} className="text-ink-secondary" />
            <div className="flex flex-wrap items-center gap-2">
              <ReportProblemButton message={message} engine={engineLabel(setupInstance)} />
            </div>
          </div>
        ) : message.includes("stall watchdog timeout") && onRetry ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <RecoveryButton icon={Play} label="Continue" onClick={onRetry} />
            <ReportProblemButton message={message} />
          </div>
        ) : message.includes("queued message failed") && onRetry ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <RecoveryButton icon={Send} label="Send Again" onClick={onRetry} />
            <ReportProblemButton message={message} />
          </div>
        ) : message.includes("offline missed routine") && onRetry ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <RecoveryButton icon={Zap} label="Run Missed Routine Now" onClick={onRetry} />
            <ReportProblemButton message={message} />
          </div>
        ) : message.includes("webhook ingress failed") && onRetry ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <RecoveryButton icon={RotateCcw} label="Restart Receiver" onClick={onRetry} />
            <ReportProblemButton message={message} />
          </div>
        ) : message.includes("git checkpoint missing") && onRetry ? (
          <div className="mt-2 flex flex-col gap-2">
            <div className="p-2 bg-black/10 rounded-md">
              <div className="flex items-center gap-1.5 text-[12.5px] font-mono text-danger/90">
                <Terminal size={12} /> git fetch origin && git checkout main
              </div>
            </div>
            <div>
              <ReportProblemButton message={message} />
            </div>
          </div>
        ) : message.includes("auto-update failed") && onRetry ? (
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
            <RecoveryButton icon={RefreshCw} label="Retry" onClick={onRetry} />
            <a href="https://botfleet.io/download" className="flex items-center gap-1.5 rounded-full bg-danger/10 border border-danger/20 px-2.5 py-1 text-[12.5px] hover:bg-danger/20 text-danger">
              <Download size={12} /> Get It From The Website
            </a>
            <ReportProblemButton message={message} />
          </div>
        ) : isComputerDispatchError(message) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {onRetry && <RecoveryButton icon={RefreshCw} label="Retry" onClick={onRetry} />}
            <RecoveryButton icon={Monitor} label="Open Computer" onClick={() => requestErrorRecovery("open-computer", botId)} />
            <RecoveryButton icon={Laptop} label="Use This Computer" onClick={() => requestErrorRecovery("use-this-computer", botId)} />
            <RecoveryButton icon={Monitor} label="Create Local VM" onClick={() => requestErrorRecovery("create-local-vm", botId)} />
            <ReportProblemButton message={message} />
          </div>
        ) : isProviderError(message) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {onRetry && (
              <RecoveryButton icon={RefreshCw} label="Retry With Fallback" onClick={onRetry} />
            )}
            <RecoveryButton icon={RefreshCw} label="Switch Model" onClick={() => requestErrorRecovery("switch-model", botId)} />
            <RecoveryButton icon={RefreshCw} label="Add API Key" onClick={() => requestErrorRecovery("add-key", botId)} />
            <ReportProblemButton message={message} />
          </div>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {onRetry && <RecoveryButton icon={RefreshCw} label="Retry" onClick={onRetry} />}
            <ReportProblemButton message={message} />
          </div>
        )}
      </div>
    </div>
  );
}

export { ErrorRow };

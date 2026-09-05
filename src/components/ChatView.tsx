import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  
  ArrowDown,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Bug,
  Clock,
  Crown,
  Folder,
  ListTree,
  Loader2,
  Monitor,
  MoreHorizontal,
  Coins,
  SlidersHorizontal,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Square,
  Webhook,
  X,
} from "lucide-react";
import { formatTokens, formatUsd } from "@/lib/usage";
import {
  useStore,
  useStreaming,
  formatTime,
  messageVersions,
  visibleMessages,
  type Bot,
  type InstanceInfo,
  type Message,
} from "@/state/store";
import { BotAvatar, MausAvatar } from "./Avatar";
import { ProviderMark } from "./ProviderIcons";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled, summarizeToolCallsEnabled } from "@/lib/feature-flags";
import { stateForBot } from "@/lib/mascot";
import { showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { modelChip } from "@/lib/model-chip";
import { ChatMarkdown } from "./ChatMarkdown";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { ErrorRow } from "./ErrorRow";
import { ChatFindBar } from "./ChatFindBar";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { AttachedImageGallery } from "./AttachmentPreview";
import { ModelPicker } from "./ModelPicker";
import { RenameTitle } from "./RenameTitle";
import { ThreadTabs } from "./ThreadTabs";
import { ReactionBar, ReactionChips } from "./Reactions";
import { CopyButton } from "./CopyButton";
import { CallButton, CallOverlay } from "./CallView";
import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { BUBBLE_EDITOR_WIDTH, BUBBLE_WIDTH, bubbleRow } from "@/lib/bubble-metrics";
import { useFocusMessage } from "@/lib/focus-message";
import { groupActivityRuns } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitAttachedImages } from "@/lib/composer-attachments";
import { BOTTOM_FOLLOW_THRESHOLD, shouldResumeBottomFollow } from "@/lib/bottom-follow";
import {
  TRANSCRIPT_WINDOW_SIZE,
  expandDisplayWindowStart,
  focusWindowRange,
  hiddenDisplayCount,
  resolveTranscriptWindow,
  tailDisplayWindowStart,
} from "@/lib/transcript-window";
import { timelineEvents } from "@/lib/taskTimeline";

/** Long user messages collapse behind a fade so pasted walls of text don't
 * bury the conversation; bots get full markdown. */
const USER_COLLAPSE_CHARS = 600;
const USER_COLLAPSE_LINES = 8;

/** "Today" / "Yesterday" / "Mon, Aug 11" — real dates, not a hardcoded label. */
function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function DaySeparator({ at }: { at: number }) {
  return (
    <div className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at)} {formatTime(at)}
    </div>
  );
}

function TaskTimeline({ messages, busy }: { messages: Message[]; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const events = useMemo(() => timelineEvents(messages), [messages]);
  if (events.length === 0) return null;
  const recent = events.slice(-8);
  return (
    <div className="w-full px-5 pt-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12.5px] text-ink-secondary hover:bg-raised/50 hover:text-ink"
      >
        <span className="flex items-center gap-1.5"><ListTree size={14} /> Execution timeline{busy ? " · running" : ""}</span>
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ol className="ml-2 border-l border-hairline/40 pb-2 pl-3">
          {recent.map((event) => (
            <li key={event.id} className="relative flex items-center gap-2 py-1 text-[12px] text-ink-secondary">
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -left-[17px] size-2 rounded-full",
                  event.state === "failed"
                    ? "bg-danger"
                    : event.state === "complete"
                      ? "bg-success"
                      : event.state === "running"
                        ? "animate-pulse bg-accent"
                        : "bg-ink-secondary",
                )}
              />
              <span className="sr-only">{event.state}: </span>
              <span className="truncate">{event.label}</span>
              <time className="ml-auto shrink-0 text-[11px] text-ink-secondary/70">{formatTime(event.at)}</time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}




/** One bad markdown node must not white-screen the app — the transcript
 * degrades to a plain-text bubble instead. */
class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className={cn(BUBBLE_WIDTH, "rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-ink")}>
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

/** Inline editor a user bubble turns into: Enter sends (forking the
 * conversation), Esc cancels. Shift+Enter for a newline, like everywhere. */
function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className={cn(BUBBLE_EDITOR_WIDTH, "rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3")}>
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // isComposing: an IME confirm-Enter must not submit the edit
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Bubble({
  bot,
  message,
  editing,
  isLastBotText,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  replyTarget,
  onReply,
}: {
  bot: Bot;
  message: Message;
  editing: boolean;
  isLastBotText: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: () => void;
}) {
  const { state, dispatch } = useStore();
  const user = message.role === "user" && !message.from?.botId;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = message.text ?? "";
  const webhookView = user ? webhookMessageView(text) : null;
  const attachedImages = user && !webhookView ? splitAttachedImages(text) : null;
  const visibleText = webhookView?.task ?? attachedImages?.display ?? text;
  const copyContent = user ? visibleText : text;
  const requestId = message.card?.requestId;
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);

  const handleBubbleClick = (e: React.MouseEvent) => {
    const selection = window.getSelection()?.toString();
    if (selection && selection.trim().length > 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("a, button, input, textarea, summary, pre, code")) return;
    if (!copyContent) return;
    void navigator.clipboard?.writeText(copyContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
    window.dispatchEvent(new CustomEvent("focus-composer"));
  };

  // one source of horizontal truth for every path below — the settled
  // bubble, the inline editor, the hover chrome
  const row = bubbleRow(user ? "user" : "bot");

  if (user && editing && !webhookView) {
    return (
      // the editor stands exactly where the bubble stood: same row, same
      // reserved gutter, same cap, so opening one never moves the message
      <div className={row.row}>
        <div className={row.gutter} aria-hidden="true" />
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
      </div>
    );
  }

  // "‹ 2/3 ›" under an edited message — every fork it belongs to
  const versions = user ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
  };

  return (
    <div className={cn("group flex w-full flex-col", user ? "animate-msg-in items-end" : "items-start")}>
      <div className={row.row}>
        {/* The user's hover chrome, parked in its reserved gutter and out of
            the flow: what is mounted here changes with `bot.busy` and with
            how long ago the message was sent, and none of that may reach the
            bubble's box. */}
        {user && (
          <div className={row.gutter}>
            <div className={row.chrome}>
              {/* editing rewinds the thread, so it waits for the turn to end —
                  same rule as the version switcher below */}
              {message.kind === "text" && !webhookView && !bot.busy && (
                <button
                  onClick={onStartEdit}
                  aria-label="Edit Message"
                  className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                  title="Edit Message"
                >
                  <Pencil size={14} />
                </button>
              )}
              <div className="flex items-center text-[11px] text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100 px-1">
                {formatHoverTime(message.at)}
              </div>
              <CopyButton
                text={copyContent}
                messageId={message.id}
                requestId={requestId}
                copied={copied}
                onCopy={() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }}
              />

              <button
                onClick={() =>
                  dispatch({
                    type: "updateBot",
                    botId: bot.id,
                    patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
                  })
                }
                aria-label={bot.pinnedMessageId === message.id ? "Unpin Message" : "Pin Message"}
                className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                title={
                  bot.pinnedMessageId === message.id
                    ? "Unpin this message"
                    : "Pin this message to the top of the thread"
                }
              >
                {bot.pinnedMessageId === message.id ? <PinOff size={14} /> : <Pin size={14} />}
              </button>
            </div>
          </div>
        )}
        <div
          onClick={handleBubbleClick}
          className={cn(
            BUBBLE_WIDTH,
            "rounded-2xl text-[15px] leading-relaxed cursor-pointer select-text relative",
            user && webhookView
              ? "overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
              : user
                ? "bg-bubble-user px-4 py-2.5 whitespace-pre-wrap text-ink"
                : "bg-card px-4 py-2.5 text-ink",
          )}
          
        >
          {replyTarget && (
            <div className="mb-2">
              <ReplyQuote
                message={replyTarget}
                fallbackName={bot.name}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: replyTarget.id })
                }
              />
            </div>
          )}
          {user && webhookView ? (
            <div className="min-w-[300px] max-w-[520px]">
              <div className="flex items-center gap-2 border-b border-accent/15 bg-accent/[0.055] px-4 py-2.5 text-[11.5px] font-medium text-accent">
                <Webhook size={13} />
                <span>Webhook Task</span>
              </div>
              <div className="px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
              {webhookView.payload && (
                <details className="border-t border-hairline/30 bg-inset/25 px-4 py-2.5 text-[11.5px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">View Event Payload</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-hairline/25 bg-black/25 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                </details>
              )}
            </div>
          ) : user ? (
            <>
              {attachedImages && attachedImages.images.length > 0 && (
                <AttachedImageGallery paths={attachedImages.images} />
              )}
              <div
                className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
              >
                {visibleText}
              </div>
              {message.steered && (
                <div className="mt-1 text-[11px] text-ink-secondary/70" title="Sent while the bot was working — it saw this before its next step, inside the same turn.">
                  sent mid-turn
                </div>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show Full Message
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  Show less
                </button>
              )}
            </>
          ) : (
            <MessageBoundary fallbackText={text}>
              <ChatMarkdown text={text} />
            </MessageBoundary>
          )}
        </div>
        {/* the bot's chrome, same deal: Regenerate is only on the newest
            message, and the reaction bar only on text — neither may resize
            the bubble it hangs off */}
        {!user && (
          <div className={row.gutter}>
            <div className={row.chrome}>
              <div className="flex items-center text-[11px] text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100 px-1">
                {formatHoverTime(message.at)}
                {bot && bot.modelSelection && (
                  <span className="ml-1.5 flex items-center" title={bot.modelSelection.model}>
                    {/* fall back to the instance id, not a hardcoded "openai": before the
                        instance list loads, that constant drew every engine — MiniMax
                        included — as an "O" badge instead of its own initial. */}
                    <ProviderMark
                      driverKind={
                        state.instances.find((i: any) => i.instanceId === bot.modelSelection.instanceId)?.driverKind ??
                        bot.modelSelection.instanceId
                      }
                      size={12}
                    />
                  </span>
                )}
              </div>
              <CopyButton
                text={copyContent}
                messageId={message.id}
                requestId={requestId}
                copied={copied}
                onCopy={() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1400);
                }}
              />
              <button
                type="button"
                onClick={onReply}
                aria-label="Reply to Message"
                className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                title="Reply"
              >
                <MessageSquareReply size={14} />
              </button>

              <button
                onClick={() =>
                  dispatch({
                    type: "updateBot",
                    botId: bot.id,
                    patch: { pinnedMessageId: bot.pinnedMessageId === message.id ? "" : message.id },
                  })
                }
                aria-label={bot.pinnedMessageId === message.id ? "Unpin Message" : "Pin Message"}
                className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                title={
                  bot.pinnedMessageId === message.id
                    ? "Unpin this message"
                    : "Pin this message to the top of the thread"
                }
              >
                {bot.pinnedMessageId === message.id ? <PinOff size={14} /> : <Pin size={14} />}
              </button>

              {isLastBotText && !bot.busy && onRegenerate && (
                <button
                  onClick={onRegenerate}
                  aria-label="Regenerate Response"
                  title="Regenerate Response"
                  className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <RefreshCw size={14} />
                </button>
              )}
              {message.kind === "text" && <ReactionBar threadId={bot.threadId} message={message} />}
            </div>
          </div>
        )}
      </div>
      {/* busy-gated so a flag stranded by a server restart shows nothing */}
      {user && message.queued && bot.busy && (
        <div className="mt-1 flex items-center gap-1 pr-1 text-[11px] text-ink-secondary/70">
          <Clock size={11} aria-hidden="true" />
          <span>Queued — sends when this turn finishes</span>
          <button
            type="button"
            onClick={() => dispatch({ type: "cancelQueued", botId: bot.id, queueId: message.queueId ?? message.id })}
            aria-label="Cancel Queued Message"
            title="Cancel Queued Message"
            className="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={11} strokeWidth={2.5} />
          </button>
        </div>
      )}
      <ReactionChips threadId={bot.threadId} message={message} align={user ? "right" : "left"} />
      {versions.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(versions[versionIndex - 1])}
            disabled={versionIndex <= 0 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Previous Version"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{versions.length}
          </span>
          <button
            onClick={() => switchTo(versions[versionIndex + 1])}
            disabled={versionIndex >= versions.length - 1 || bot.busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title="Next Version"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A tool run: spinner while live, check/cross once settled. */
function ActivityChip({ bot, message }: { bot: Bot, message: Message }) {
  const { dispatch } = useStore();
  const [expanded, setExpanded] = useState(false);
  const tool = message.tool;
  if (!tool) return null;
  // bot⇄bot comm chip: opens the channel where the exchange lives
  const comm = message.comm;
  if (comm) {
    if (expanded) {
      return (
        <div className="flex justify-start">
          <div className="flex flex-col gap-2 rounded-xl border border-hairline/40 bg-panel p-3 shadow-sm min-w-[320px] max-w-[480px]">
             <div className="flex items-center justify-between">
                <button onClick={() => setExpanded(false)} className="flex items-center gap-2 text-[13px] text-ink-secondary hover:text-ink">
                  <MausAvatar color={comm.withColor} state="happy" size={16} />
                  <span className="font-medium truncate">{tool.name}</span>
                  <ChevronDown size={13} />
                </button>
                <button
                  onClick={() => dispatch({ type: "select", id: comm.groupId })}
                  title={`Open the conversation with ${comm.withName}`}
                  className="rounded bg-control px-2 py-1 text-[11px] font-medium text-ink hover:bg-raised-hover"
                >
                  View Chat
                </button>
             </div>
             <div className="mt-1 text-[13px] text-ink whitespace-pre-wrap">
               {message.text}
             </div>
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-start">
        <button
          onClick={() => setExpanded(true)}
          title={`Expand message`}
          className="flex items-center gap-2 rounded-xl border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <MausAvatar color={comm.withColor} state="happy" size={16} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  const failed = tool.ok === false;
  const time = new Date(message.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const actor = message.from?.name ?? bot.name;
  const tooltip = `${actor} ran this tool at ${time}${failed ? " (Failed)" : tool.ok ? " (Success)" : " (Running)"}`;
  
  return (
    <div className="flex justify-start">
      <div
        title={tooltip}
        className={cn(
          "flex items-start gap-2.5 rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[13px] shadow-sm",
          failed ? "border-danger/30 text-danger bg-danger/5" : "text-ink-secondary",
        )}
      >
        <div className="mt-0.5 shrink-0">
          {tool.ok === undefined ? (
            <Loader2 size={13} className="animate-spin text-accent" />
          ) : failed ? (
            <X size={13} className="text-danger" />
          ) : (
            <Check size={13} className="text-success" />
          )}
        </div>
        <span className="max-w-[540px] break-words font-mono text-[12px] leading-relaxed select-text">{tool.name}</span>
      </div>
    </div>
  );
}

function ScreenFrame({ png, mime }: { png: string; mime?: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={`data:${mime ?? "image/png"};base64,${png}`}
        alt="Bot's screen"
        className="w-fit max-w-[min(42rem,85%)] rounded-2xl border border-hairline/40"
      />
    </div>
  );
}

/** The settled transcript, memoized as one unit: during streaming every
 * frame re-renders ChatView, but all of these props keep their identity
 * (bot/messages only change on real message events), so the whole list —
 * every markdown tree, every code block — bails out of React work and only
 * the streaming tail below it commits. This is the t3code structural-sharing
 * idea at component granularity. */
const MessagesList = memo(function MessagesList({
  bot,
  messages,
  transcript,
  editingId,
  lastBotTextId,
  emergingId,
  canRetryLast,
  engine,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onReply,
}: {
  bot: Bot;
  messages: Message[];
  /** Active-branch messages, including ones outside the mounted window. */
  transcript: Message[];
  editingId: string | null;
  lastBotTextId: string | undefined;
  emergingId?: string | null;
  canRetryLast: boolean;
  /** This bot's engine, for rendering setup help on a `setup` error. */
  engine: InstanceInfo | undefined;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  onReply: (message: Message) => void;
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  const summarizeToolCalls = summarizeToolCallsEnabled(state.config);
  // Fold finished tool chips into runs when summarizeToolCalls is enabled, so a stretch of them cannot bury
  // what the bot actually said. If summarizeToolCalls is false, show each step individually.
  const items = useMemo(
    () => (summarizeToolCalls ? groupActivityRuns(messages) : messages.map((m) => ({ kind: "message" as const, message: m }))),
    [messages, summarizeToolCalls],
  );
  // A search hit inside a folded run has to open it: the fold keeps the
  // row out of the DOM, and there is nothing for the scroll to land on.
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === bot.threadId ? focus.messageId : null;
  return (
    <>
      {messages.length === 0 && !bot.busy && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          <BotAvatar bot={bot} state={stateForBot(bot)} size={64} motion="none" motionKey={0} />
          <RenameTitle
            value={bot.name}
            onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
            className="text-[17px] font-semibold text-ink"
            inputClassName="rounded bg-inset px-1.5 py-0.5 text-center text-[17px] font-semibold"
          />
          <div className="max-w-[360px] text-[14px] text-ink-secondary">
            {bot.description || "Send a message to start the conversation."}
          </div>
        </div>
      )}
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "run" ? previous.messages.at(-1) : previous.message);
        const first = item.kind === "run" ? item.messages[0] : item.message;
        const newDay = !prev || new Date(prev.at).toDateString() !== new Date(first.at).toDateString();
        if (item.kind === "run") {
          if (!showToolCalls) return null;
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} />}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <ActivityChip bot={bot} message={step} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        if (m.id === emergingId) return null;
        const row = (() => {
          switch (m.kind) {
            case "secret":
              return m.secret ? <SecretRequestCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "connector":
              return m.connector ? <ConnectorCard botId={bot.id} threadId={bot.threadId} message={m} /> : null;
            case "options":
              // a live permission ask gets the approval box; questions keep
              // the list card. The first-run quiz drops out once they talk.
              if (m.card?.requestId && m.card.tool) {
                return <ApprovalCard bot={bot} message={m} />;
              }
              if (shouldHideOnboardingCard(m, transcript)) return null;
              return <OptionCard botId={bot.id} message={m} />;
            case "activity": {
              // a failed turn is an error, not a tool run — render it as one.
              // bot⇄bot comm chips stay because they link to another conversation.
              // plain tool runs stay out unless Settings → Tool calls is on.
              if (m.tool?.name.startsWith("error:")) {
                return (
                  <ErrorRow
                    message={m.tool.name.slice(6).trim()}
                    onRetry={m.id === messages.at(-1)?.id && canRetryLast ? onRegenerate : undefined}
                    setupInstance={m.tool.setup ? engine : undefined}
                    botId={bot.id}
                  />
                );
              }
              if (!showToolCalls && !m.comm) return null;
              return <ActivityChip bot={bot} message={m} />;
            }
            case "screen":
              return m.png ? <ScreenFrame png={m.png} mime={m.mime} /> : null;
            default:
              return (
                <Bubble
                  bot={bot}
                  message={m}
                  editing={editingId === m.id}
                  isLastBotText={m.id === lastBotTextId}
                  onStartEdit={() => onStartEdit(m.id)}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={(text) => onSubmitEdit(m.id, text)}
                  onRegenerate={onRegenerate}
                  replyTarget={m.replyToId ? bot.messages.find((candidate) => candidate.id === m.replyToId) : undefined}
                  onReply={() => onReply(m)}
                />
              );
          }
        })();
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && <DaySeparator at={m.at} />}
            {row}
          </div>
        );
      })}
    </>
  );
});

/** The one pinned message, above the transcript: sender, one line, click to
 * jump, X to unpin. Resolves the pin id against the full message list; a
 * pin that no longer resolves renders nothing (edited away or deleted). */
function PinnedBanner({
  bot,
  pinnedId,
  messages,
  onJump,
  onUnpin,
}: {
  bot: Bot;
  pinnedId?: string;
  messages: Message[];
  onJump: (messageId: string) => void;
  onUnpin: () => void;
}) {
  const pinned = messages.find((m) => m.id === pinnedId);
  if (!pinned || pinned.kind !== "text") return null;
  const sender =
    pinned.role === "user" ? "You" : (pinned.from?.name ?? bot.name);
  const text = (pinned.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return (
    <div className="w-full px-5">
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
        <Pin size={12} className="shrink-0 text-accent" />
        <button
          onClick={() => onJump(pinned.id)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          title="Jump to the pinned message"
        >
          <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
          <span className="truncate text-[12.5px] text-ink-secondary">{text}</span>
        </button>
        <button
          onClick={onUnpin}
          aria-label="Unpin Message"
          title="Unpin"
          className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

function formatHoverTime(at: number) {
  const date = new Date(at);
  const now = new Date();
  const isSameDay = date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (isSameDay) return timeStr;
  return `${date.getMonth() + 1}/${date.getDate()} ${timeStr}`;
}

export function ChatView({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  const stream = useStreaming();
  const streaming = stream.streaming[bot.threadId];
  const reasoning = stream.reasoning[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const [findOpen, setFindOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  useEffect(() => setFindOpen(false), [bot.threadId]);
  useEffect(() => setReplyTo(null), [bot.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  const pendingQueued = state.pendingQueued[bot.threadId] ?? [];
  const messages = useMemo(() => {
    const visible = visibleMessages(bot);
    if (!pendingQueued.length) return visible;
    const queued: Message[] = pendingQueued.map((entry) => ({
      id: entry.queueId,
      at: Date.now(),
      role: "user",
      kind: "text",
      text: entry.text,
      queued: true,
      queueId: entry.queueId,
    }));
    return [...visible, ...queued];
  }, [bot, pendingQueued]);
  // Windowed transcript: only a tail of the thread mounts (screenshots make
  // full threads DOM-heavy). Count on-screen items, not raw rows — hidden
  // tool chips must not push the user prompt that started a long turn out
  // of the default tail. The boundary is anchored per bot+task+display
  // mode; a render-phase reset re-tails it on switch so the old thread's
  // boundary never flashes into the new one. Everything derived below
  // (lastBotTextId, lastUserMessage, working dots) stays computed from the
  // FULL list.
  const includeToolCalls = showToolCallsEnabled(state.config);
  const summarizeToolCalls = summarizeToolCallsEnabled(state.config);
  const displayWindow = { includeToolCalls, summarizeToolCalls };
  const transcriptKey = `${bot.id}:${bot.threadId}:${includeToolCalls ? "tools" : "chat"}:${summarizeToolCalls ? "sum" : "all"}`;
  const [transcriptWindow, setTranscriptWindow] = useState<{
    key: string;
    start: number;
    end: number | null;
  }>(() => ({
    key: transcriptKey,
    start: tailDisplayWindowStart(messages, displayWindow),
    end: null,
  }));
  if (transcriptWindow.key !== transcriptKey) {
    setTranscriptWindow({
      key: transcriptKey,
      start: tailDisplayWindowStart(messages, displayWindow),
      end: null,
    });
  }
  const {
    visible: windowedMessages,
    laterCount,
    startIndex,
    endIndex,
  } = useMemo(
    () => resolveTranscriptWindow(messages, transcriptWindow.start, TRANSCRIPT_WINDOW_SIZE, transcriptWindow.end),
    [messages, transcriptWindow.start, transcriptWindow.end],
  );
  const hiddenCount = hiddenDisplayCount(messages, startIndex, displayWindow);

  const lastBotTextId = useMemo(
    () => [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [messages],
  );

  // one message at a time may be in edit mode
  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id]);
  // stable handler identities — MessagesList is memo'd on them
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null); // closes the editor first — a double Enter can't fork twice
      dispatch({ type: "editMessage", botId: bot.id, messageId, text });
    },
    [bot.id, dispatch],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text"),
    [messages],
  );

  // Mascot while the turn works. Streaming stays invisible — when the reply
  // is finished, the whole bubble pops in above the mascot.
  const lastMessage = messages.at(-1);
  const toolInFlight = lastMessage?.kind === "activity" && lastMessage.tool?.ok === undefined;
  const activityLabel = liveActivityLabel(lastMessage);
  const waiting = Boolean(
    bot.busy &&
      bot.activity !== "waiting-on-you" &&
      showWorkingDots(bot.busy, undefined, lastMessage),
  );
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<{ id: string; text: string } | null>(null);
  useEffect(() => {
    wasWaiting.current = false;
    setPopping(null);
  }, [bot.id]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useEffect(() => {
    if (lastMessage?.role !== "bot" || lastMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    setPopping({ id: lastMessage.id, text: lastMessage.text ?? "" });
    const timer = setTimeout(() => setPopping(null), 520);
    return () => clearTimeout(timer);
  }, [lastMessage?.id, lastMessage?.role, lastMessage?.kind, lastMessage?.text]);
  const presenceVisible = waiting || popping !== null;
  const presenceModel = modelChip(bot, state.instances);

  // regenerate = fork the last user message with the same text — reuses the
  // existing branch machinery, so the old answer stays reachable via ‹ ›
  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy) {
      dispatch({ type: "editMessage", botId: bot.id, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, dispatch]);

  // Scroll pinning: follow the bottom while the user hasn't scrolled away.
  // Follow breaks ONLY on an upward user gesture (wheel/touch), never on
  // scroll position checks — streamed content growth flickers "at bottom"
  // false for a frame, and breaking there kills follow permanently
  // (upstream-verified failure). Scrolling back to the end re-arms it.
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  const previousScrollTop = useRef(0);
  const touchY = useRef(0);

  const setBottomFollow = useCallback((next: boolean) => {
    followRef.current = next;
    setFollow(next);
  }, []);

  useEffect(() => setBottomFollow(true), [bot.id, setBottomFollow]);

  // A search result may be hundreds of rows before the mounted tail. Open a
  // bounded window around it first; useFocusMessage then scrolls and flashes
  // the row after React commits that window.
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== bot.threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    if (targetIndex < 0) return;
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [bot.threadId, messages, setBottomFollow, state.focusMessage, transcriptKey]);
  useFocusMessage(bot.threadId, messages.length > 0);

  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [bot.id, messages.length, streaming, reasoning, bot.busy, follow]);

  // Expanding prepends rows: capture the height first, then after the commit
  // shift scrollTop by the growth so the message under the cursor stays put
  // (browser scroll anchoring is disabled on this container).
  const preExpandHeight = useRef<number | null>(null);
  const showEarlier = () => {
    preExpandHeight.current = scrollRef.current?.scrollHeight ?? null;
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    const start = expandDisplayWindowStart(messages, startIndex, displayWindow);
    setTranscriptWindow((w) => ({ ...w, start }));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (preExpandHeight.current === null || !el) return;
    el.scrollTop += el.scrollHeight - preExpandHeight.current;
    preExpandHeight.current = null;
    // keep the resume-follow heuristic from reading the restore as a
    // downward user scroll
    previousScrollTop.current = el.scrollTop;
  }, [transcriptWindow.start]);

  const showLater = () => {
    setBottomFollow(false);
    const nextEnd = Math.min(messages.length, endIndex + TRANSCRIPT_WINDOW_SIZE);
    setTranscriptWindow((w) => ({ ...w, end: nextEnd >= messages.length ? null : nextEnd }));
  };

  // keyboard is a scroll gesture too (upstream lesson): PageUp/Home break
  // follow like an upward wheel; the at-end onScroll check re-arms it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageUp" || (e.key === "Home" && !(e.target instanceof HTMLTextAreaElement))) {
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow]);

  const atEnd = () => {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_FOLLOW_THRESHOLD;
  };
  const jumpToLatest = () => {
    setBottomFollow(true);
    setTranscriptWindow({
      key: transcriptKey,
      start: tailDisplayWindowStart(messages, displayWindow),
      end: null,
    });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Call mode covers the thread while the bot is on the line */}
      <CallOverlay bot={bot} />
      {/* Header */}
      <div
        className={cn(
          // @container so the chips on the right can fold gracefully
          "@container/chathead flex items-center justify-between gap-3 px-5 py-3",
          // Room for the drawer button, which overlays this corner below md.
          "pl-11 md:pl-5",
        )}
      >
        <div className="flex shrink-0 min-w-0 max-w-[45%] items-center gap-2 rounded-lg px-1.5 py-1">
          <button
            onClick={() => dispatch({ type: "toggleSettings", open: true })}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-raised/50"
            title="Open Bot Profile"
            aria-label={`Open ${bot.name}'s Profile`}
          >
            <BotAvatar
              bot={bot}
              state={stateForBot({ ...bot, messages })}
              size={28}
              motion={mascotMotion?.kind ?? "none"}
              motionKey={mascotMotion?.nonce ?? 0}
            />
          </button>
          <RenameTitle
            value={bot.name}
            onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
            onActivate={() => dispatch({ type: "toggleSettings", open: true })}
            showEditButton
            className="truncate min-w-[80px] text-[15px] font-semibold text-ink"
            inputClassName="max-w-[220px] rounded bg-inset px-1.5 py-0.5 text-[15px] font-semibold"
          />
          {bot.chiefOfStaff && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent">
              <Crown size={11} />
              <span className="@max-2xl/chathead:hidden">Chief of Staff</span>
            </span>
          )}
          {bot.busy && <Loader2 size={14} className="shrink-0 animate-spin text-ink-secondary" />}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 md:gap-2">
          <button
            onClick={() => setFindOpen((open) => !open)}
            aria-label="Find in Conversation"
            aria-pressed={findOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title="Find in Conversation (⌘F)"
          >
            <Search size={18} />
          </button>
          {bot.busy && (
            <button
              onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
                COMPACT_BUBBLE,
              )}
              title="Stop this turn"
            >
              <Square size={12} className="fill-current" />
              <span className="@max-4xl/chathead:hidden">Stop</span>
            </button>
          )}
          <ModelPicker bot={bot} />
          <CallButton bot={bot} />
          <ChatHeaderOverflowMenu bot={bot} />
        </div>
      </div>

      <ThreadTabs bot={bot} />

      {findOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}

      
      {/* Pinned message banner */}
      <PinnedBanner
        bot={bot}
        pinnedId={bot.pinnedMessageId}
        messages={messages}
        onJump={(messageId) =>
          dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })
        }
        onUnpin={() =>
          dispatch({ type: "updateBot", botId: bot.id, patch: { pinnedMessageId: "" } })
        }
      />

      {showToolCallsEnabled(state.config) && <TaskTimeline messages={messages} busy={bot.busy ?? false} />}

      {/* Messages + composer share one pane so bubbles scroll into the pill
          instead of dying on a rectangular clip above a black dock. */}
      <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="h-full overflow-x-hidden overflow-y-auto px-5 [overflow-anchor:none]"
        onWheel={(e) => {
          if (e.deltaY < 0) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onTouchStart={(e) => (touchY.current = e.touches[0]?.clientY ?? 0)}
        onTouchMove={(e) => {
          const y = e.touches[0]?.clientY ?? 0;
          if (y > touchY.current + 4) setBottomFollow(false);
          else if (atEnd()) setBottomFollow(true);
        }}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          const scrollTop = el.scrollTop;
          const resume = shouldResumeBottomFollow({
            following: followRef.current,
            previousScrollTop: previousScrollTop.current,
            scrollTop,
            distanceFromBottom: el.scrollHeight - scrollTop - el.clientHeight,
          });
          previousScrollTop.current = scrollTop;
          if (resume) setBottomFollow(true);
        }}
      >
        <div
          className="flex w-full flex-col gap-3 pb-56"
          role="log"
          aria-live="polite"
          aria-label={`Conversation with ${bot.name}`}
        >
          {hiddenCount > 0 && (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Show earlier messages ({hiddenCount} more)
              </button>
            </div>
          )}
          <MessagesList
            bot={bot}
            messages={windowedMessages}
            transcript={messages}
            editingId={editingId}
            lastBotTextId={lastBotTextId}
            emergingId={popping?.id}
            canRetryLast={!bot.busy && Boolean(lastUserMessage)}
            engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSubmitEdit={submitEdit}
            onRegenerate={regenerate}
            onReply={setReplyTo}
          />
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                Show later messages ({laterCount} more)
              </button>
            </div>
          )}
          {provisioning && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <Loader2 size={13} className="animate-spin" />
                Setting up this bot's computer…
              </div>
            </div>
          )}
          <TurnPresence
            avatar={
              <MausAvatar
                color={bot.color}
                state={toolInFlight ? "working" : "thinking"}
                size={36}
                forward={false}
                lookAround={1}
                trackPointer={false}
              />
            }
            visible={presenceVisible}
            label={activityLabel}
            answering={popping !== null}
            modelMark={presenceModel ? <ProviderMark driverKind={presenceModel.driverKind} size={14} /> : undefined}
            modelName={presenceModel?.name}
          >
            {popping ? (
              <div className={cn(BUBBLE_WIDTH, "rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink")}>
                <MessageBoundary fallbackText={popping.text}>
                  <ChatMarkdown text={popping.text} />
                </MessageBoundary>
              </div>
            ) : null}
          </TurnPresence>
        </div>
      </div>

      {/* Reading scrollback — one tap back to the end, streaming or not */}
      {!follow && (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to Latest Messages"
          className="animate-pop-in absolute bottom-24 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to Latest
        </button>
      )}

      {/* keyed by bot: a draft belongs to the conversation it was typed in,
          so switching bots starts from an empty composer instead of carrying
          the previous bot's half-written message over. ArrowUp-to-edit is
          gated on busy like the pencil button — editing rewinds the thread,
          which a live turn forbids (the server 409s it). */}
      <div className="absolute inset-x-0 bottom-0 z-[2]">
      <Composer
        key={bot.id}
        bot={bot}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        onEditLast={lastUserMessage && !bot.busy ? () => setEditingId(lastUserMessage.id) : undefined}
      />
      </div>
      </div>

    </main>
  );
}

function ChatHeaderOverflowMenu({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const folder = task?.cwd === undefined ? bot.cwd : (task.cwd ?? undefined);
  const folderName = folder ? (folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder) : null;
  const usage = task?.usage;
  const usageLabel = usage
    ? usage.costUsd !== null
      ? formatUsd(usage.costUsd)
      : formatTokens(usage.input + usage.output)
    : null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink",
          open && "bg-raised text-ink",
        )}
        title="More Actions"
      >
        <MoreHorizontal size={18} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-xl border border-hairline/50 bg-card p-1.5 shadow-2xl shadow-black/50">
          {/* Working Folder */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              dispatch({ type: "toggleSettings", open: true });
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised/60"
          >
            <Folder size={15} className="shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium">Working Folder</div>
              <div className="truncate font-mono text-[11px] text-ink-secondary">
                {folderName ?? "Private bot workspace"}
              </div>
            </div>
          </button>

          {/* Usage Metrics */}
          {usage && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                dispatch({ type: "toggleSettings", open: true });
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised/60"
            >
              <Coins size={15} className="shrink-0 text-ink-secondary" />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium">Session Usage</div>
                <div className="text-[11px] text-ink-secondary">
                  {usageLabel} · {usage.turns} turn{usage.turns === 1 ? "" : "s"}
                </div>
              </div>
            </button>
          )}

          <div className="my-1 border-t border-hairline/30" />

          {/* Computer Panel Toggle */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              dispatch({ type: "toggleComputer" });
            }}
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised/60"
          >
            <span className="flex items-center gap-2.5">
              <Monitor size={15} className="text-ink-secondary" /> Bot's Computer
            </span>
            {state.computerOpen && <span className="size-1.5 rounded-full bg-accent" />}
          </button>

          {/* Inspector Toggle */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              dispatch({ type: "toggleInspector" });
            }}
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised/60"
          >
            <span className="flex items-center gap-2.5">
              <Bug size={15} className="text-ink-secondary" /> Inspector
            </span>
            {state.inspectorOpen && <span className="size-1.5 rounded-full bg-accent" />}
          </button>

          <div className="my-1 border-t border-hairline/30" />

          {/* Bot Profile Settings */}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              dispatch({ type: "toggleSettings", open: true });
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-raised/60"
          >
            <SlidersHorizontal size={15} className="shrink-0 text-ink-secondary" />
            <span>Bot Profile &amp; Settings</span>
          </button>
        </div>
      )}
    </div>
  );
}


import { Component, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  
  ArrowDown,
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
  MessageCircle,
  MessageSquareReply,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import { formatTokens, formatUsd } from "@/lib/usage";
import {
  api,
  useStore,
  useStreaming,
  formatTime,
  messageVersions,
  visibleMessages,
  type Bot,
  type InstanceInfo,
  type Message,
} from "@/state/store";
import { BotAvatar, BotMascot } from "./Avatar";
import { usePageVisible } from "@/lib/page-visible";
import { ProviderMark } from "./ProviderIcons";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled, summarizeToolCallsEnabled } from "@/lib/feature-flags";
import { automationSourceLabel } from "@/lib/replies";
import { stateForBot } from "@/lib/mascot";
import { showWorkingDots } from "@/lib/turn-tail";
import { liveActivityLabel } from "@/lib/live-activity";
import { modelChip } from "@/lib/model-chip";
import { ChatMarkdown } from "./ChatMarkdown";
import { splitVoiceSummary, stripVoiceSummaryTags } from "../../shared/voice-summary";
import { useSpeech } from "@/lib/tts/useSpeech";
import { MentionText } from "./MentionText";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { ErrorRow, TurnErrorAnnouncement, latestTurnErrorMessage, turnErrorBranchKey } from "./ErrorRow";
import { ChatFindBar } from "./ChatFindBar";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { AttachedFileChips, AttachedImageGallery } from "./AttachmentPreview";
import { ModelPicker } from "./ModelPicker";
import { RenameTitle } from "./RenameTitle";
import { ThreadStatsBar } from "./ThreadStatsBar";
import { ThreadTabs } from "./ThreadTabs";
import { ThreadViewSwitch } from "./ThreadViewSwitch";
import { TrajectoryView } from "./TrajectoryView";
import { requestTrajectorySearch } from "@/lib/trajectory-search";
import { useThreadView } from "@/lib/thread-view";
import { ReactionBar, ReactionChips } from "./Reactions";
import { CopyButton } from "./CopyButton";
import { SpeakButton } from "./SpeakButton";
import { CallButton, CallOverlay } from "./CallView";
import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE } from "@/lib/compact-chip";
import { BUBBLE_EDITOR_WIDTH, BUBBLE_WIDTH, bubbleRow } from "@/lib/bubble-metrics";
import { useFocusMessage } from "@/lib/focus-message";
import { groupActivityRuns, nestHelperSteps } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { JobFinishedRow, JobsMenu } from "./JobsMenu";
import { jobWakeSubtitle } from "../../shared/jobs";
import { ToolLine } from "./ToolLine";
import { ContextInjectionRows } from "./ContextInjectionRows";
import { webhookMessageView } from "@/lib/webhook-message";
import { WebhookCard } from "./WebhookCard";
import { imessageMessageView, stripToImessagePrefix } from "../../shared/imessage-message";
import { delegationMessageView, isDelegationMessage } from "../../shared/delegation-message";
import { DelegationCard } from "./DelegationCard";
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
              <span className="truncate" title={event.label}>{event.label}</span>
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

/** Inline editor a user bubble or system work card turns into: Enter sends
 * (forking the conversation), Esc cancels.  Shift+Enter for a newline, like
 * everywhere.  User chrome stays the blue You bubble; system chrome is the
 * left-edge hairline card, never `bg-bubble-user`. */
function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
  chrome = "user",
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
  chrome?: "user" | "system";
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
    <div
      className={
        chrome === "system"
          ? "w-full min-w-0 max-w-[36rem] rounded-xl border border-hairline/40 bg-raised px-4 py-3"
          : cn(BUBBLE_EDITOR_WIDTH, "rounded-2xl border border-hairline/40 bg-bubble-user px-4 py-3")
      }
    >
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

function SpokenSummaryCard({
  messageId,
  voiceText,
  legacyVoice,
}: {
  messageId: string;
  voiceText?: string;
  legacyVoice?: string;
}) {
  const speech = useSpeech();
  const isMine = speech.messageId === messageId && speech.status === "speaking";
  const isPreparing = speech.messageId === messageId && speech.status === "preparing";
  const spokenText = (isMine && speech.caption) || voiceText || legacyVoice || "";

  if (!spokenText && !isMine && !isPreparing) return null;

  const words = spokenText.trim().split(/\s+/).filter(Boolean);
  const activeWordIdx = isMine ? speech.wordIndex ?? -1 : -1;

  return (
    <details
      open={isMine || isPreparing ? true : undefined}
      className="mt-2 border-t border-hairline/40 pt-2"
      onClick={(event) => event.stopPropagation()}
    >
      <summary className="cursor-pointer text-[12px] font-medium text-ink-secondary hover:text-ink flex items-center gap-1.5 select-none">
        <span>Spoken Summary</span>
        {isMine && (
          <span className="inline-flex items-center gap-1 text-[11px] text-accent font-normal animate-pulse">
            • Reading aloud
          </span>
        )}
        {isPreparing && (
          <span className="inline-flex items-center gap-1 text-[11px] text-ink-secondary/70 font-normal">
            • Preparing audio…
          </span>
        )}
      </summary>
      <div className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
        {isMine && words.length > 0 ? (
          <p className="select-text">
            {words.map((word, idx) => {
              const isCurrent = idx === activeWordIdx;
              const isPast = activeWordIdx >= 0 && idx < activeWordIdx;
              return (
                <span
                  key={idx}
                  className={cn(
                    "transition-colors duration-75",
                    isCurrent && "font-bold text-accent px-0.5 rounded bg-accent/15",
                    isPast && "text-ink font-medium",
                    !isCurrent && !isPast && "text-ink-secondary/70",
                  )}
                >
                  {word}{" "}
                </span>
              );
            })}
          </p>
        ) : (
          <ChatMarkdown text={spokenText} />
        )}
      </div>
    </details>
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
  // Two independent questions, deliberately kept apart: which side of the
  // row a bubble sits on, versus whether it gets the human's purple
  // treatment. Any `role: "user"` message aligns right — including a peer
  // bot's `ask_bot` reply mirrored into this thread (`from.botId` set) —
  // but purple is reserved for what the human actually typed.  Auto
  // instructions are `role: "system"` and never sit on the human side.
  const alignRight = message.role === "user" && !isDelegationMessage(message);
  const humanTyped = alignRight && !message.from?.botId;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewCorrection, setReviewCorrection] = useState("");
  const [reviewComment, setReviewComment] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [recordingPlaying, setRecordingPlaying] = useState(false);
  const recordingAudio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { recordingAudio.current?.pause(); recordingAudio.current = null; }, []);
  const playRecording = () => {
    if (recordingAudio.current) {
      recordingAudio.current.pause();
      recordingAudio.current = null;
      setRecordingPlaying(false);
      return;
    }
    const audio = new Audio(`/api/threads/${bot.threadId}/messages/${message.id}/recording`);
    recordingAudio.current = audio;
    audio.onended = () => { recordingAudio.current = null; setRecordingPlaying(false); };
    audio.onerror = () => { recordingAudio.current = null; setRecordingPlaying(false); setReviewError("Could not replay recording."); };
    setRecordingPlaying(true);
    void audio.play().catch(() => { recordingAudio.current = null; setRecordingPlaying(false); setReviewError("Could not replay recording."); });
  };
  const saveReview = async () => {
    try {
      await api(`/api/threads/${bot.threadId}/messages/${message.id}/recording-review`, {
        method: "PATCH",
        body: JSON.stringify({ correction: reviewCorrection, comment: reviewComment }),
      });
      setReviewOpen(false);
      setReviewError("");
    } catch (error) { setReviewError(error instanceof Error ? error.message : "Could not save review."); }
  };
  const text = message.text ?? "";
  const voiceSections = message.role === "bot" && message.kind === "text" ? splitVoiceSummary(text) : null;
  const cleanWritten = message.role === "bot" && message.kind === "text" ? stripVoiceSummaryTags(text) : text;
  const toImessageBody = !humanTyped && message.role === "bot" ? stripToImessagePrefix(cleanWritten) : null;
  const attachedImages = humanTyped ? splitAttachedImages(text) : null;
  const visibleText = attachedImages?.display ?? cleanWritten;
  const copyContent = humanTyped ? visibleText : (toImessageBody ?? cleanWritten);
  const requestId = message.card?.requestId;
  const collapsible =
    humanTyped && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);

  const handleBubbleClick = (e: React.MouseEvent) => {
    const selection = window.getSelection()?.toString();
    if (selection && selection.trim().length > 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("a, button, input, textarea, summary, pre, code, img")) return;
    if (!copyContent) return;
    void navigator.clipboard?.writeText(copyContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
    window.dispatchEvent(new CustomEvent("focus-composer"));
  };

  // one source of horizontal truth for every path below — the settled
  // bubble, the inline editor, the hover chrome
  const row = bubbleRow(alignRight ? "user" : "bot");

  if (humanTyped && editing) {
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
  const versions = humanTyped ? messageVersions(bot, message) : [message];
  const versionIndex = versions.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !bot.busy) dispatch({ type: "switchBranch", botId: bot.id, messageId: v.id });
  };

  // The thread's own bot chrome (reply, pin, copy, reactions) — unchanged
  // content whether it belongs to the bot's own message (trailing gutter)
  // or a peer bot's reply mirrored in as `role: "user"` (leading gutter,
  // since it aligns right like anything else with that role).
  const botChrome = (
    <div className={row.gutter}>
      <div className={row.chrome}>
        {/* Row 1: date / time */}
        <div className="flex items-center text-[12.5px] text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100 px-1">
          {formatHoverTime(message.at)}
        </div>
        {/* Row 2: copy, reply, pin — plus Regenerate, which only ever
            joins them on the newest reply. */}
        <div className="flex items-center gap-1.5">
          <CopyButton
            iconSize={17}
            text={copyContent}
            messageId={message.id}
            requestId={requestId}
            copied={copied}
            onCopy={() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          />
          {message.role === "bot" && message.kind === "text" && (
            <SpeakButton
              text={text}
              botId={bot.id}
              threadId={bot.threadId}
              messageId={message.id}
              voiceId={bot.voice}
              hasAudio={Boolean(message.audio?.length)}
            />
          )}
          <button
            type="button"
            onClick={onReply}
            aria-label="Reply to Message"
            className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            title="Reply"
          >
            <MessageSquareReply size={17} />
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
            {bot.pinnedMessageId === message.id ? <PinOff size={17} /> : <Pin size={17} />}
          </button>

          {isLastBotText && !bot.busy && onRegenerate && (
            <button
              onClick={onRegenerate}
              aria-label="Regenerate Response"
              title="Regenerate Response"
              className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <RefreshCw size={17} />
            </button>
          )}
        </div>
        {/* Row 3: reactions, the "+", then which model answered — the mark
            is a logo only; the model name still lives in its tooltip. */}
        <div className="flex items-center gap-1.5">
          {message.kind === "text" && <ReactionBar threadId={bot.threadId} message={message} />}
          {message.role === "bot" && message.modelSelection && (() => {
            const instance = state.instances.find((i: any) => i.instanceId === message.modelSelection?.instanceId);
            const modelOption = instance?.models?.options?.find((o: any) => o.id === message.modelSelection?.model);
            const modelName = modelOption?.label || message.modelSelection.model;
            const title = instance ? `${modelName} (${instance.displayName || instance.driverKind})` : message.modelSelection.model;
            return (
              <span
                className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                title={title}
              >
                <ProviderMark driverKind={instance?.driverKind ?? "openai"} model={message.modelSelection.model} size={16} />
              </span>
            );
          })()}
        </div>
      </div>
    </div>
  );

  return (
    <div className={cn("group flex w-full flex-col", alignRight ? "animate-msg-in items-end" : "items-start")}>
      {/* A peer bot's reply still needs to say WHICH bot — position on the
          right no longer makes that obvious the way "it's on the left" used
          to. */}
      {alignRight && !humanTyped && message.from?.name && (
        <div className="mb-1 flex items-center gap-1.5 pr-1">
          <BotMascot color={message.from.color} state="happy" size={16} animated={false} />
          <span className="text-[11px] font-medium text-ink-secondary">{message.from.name}</span>
        </div>
      )}
      <div className={row.row}>
        {/* The human's hover chrome, parked in its reserved gutter and out of
            the flow: what is mounted here changes with `bot.busy` and with
            how long ago the message was sent, and none of that may reach the
            bubble's box. */}
        {humanTyped && (
          <div className={row.gutter}>
            <div className={row.chrome}>
              {/* Row 1: date / time */}
              <div className="flex items-center text-[12.5px] text-ink-secondary/70 opacity-0 transition-opacity group-hover:opacity-100 px-1">
                {formatHoverTime(message.at)}
              </div>
              {/* Row 2: Edit (waits for the turn to end — same rule as the
                  version switcher below, since editing rewinds the thread),
                  copy, pin. There is no reply/reactions row here: you can't
                  reply to or react to your own message today, so row 3 is
                  simply empty. */}
              <div className="flex items-center gap-1.5">
                {message.kind === "text" && !message.recording && !bot.busy && (
                  <button
                    onClick={onStartEdit}
                    aria-label="Edit Message"
                    className="rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                    title="Edit Message"
                  >
                    <Pencil size={17} />
                  </button>
                )}
                <CopyButton
                  iconSize={17}
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
                  {bot.pinnedMessageId === message.id ? <PinOff size={17} /> : <Pin size={17} />}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* leading placement: a peer bot's reply, aligning right like any
            other role="user" message */}
        {alignRight && !humanTyped && botChrome}
        <div
          onClick={handleBubbleClick}
          className={cn(
            BUBBLE_WIDTH,
            "rounded-2xl text-[15px] leading-relaxed cursor-pointer select-text relative",
            humanTyped ? "bg-bubble-user px-4 py-2.5 whitespace-pre-wrap text-ink" : "bg-card px-4 py-2.5 text-ink",
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
          {humanTyped ? (
            <>
              {attachedImages && attachedImages.images.length > 0 && (
                <AttachedImageGallery paths={attachedImages.images} />
              )}
              {attachedImages && attachedImages.files.length > 0 && (
                <AttachedFileChips paths={attachedImages.files} />
              )}
              <div
                className={cn(collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
              >
                <MentionText text={visibleText} />
              </div>
              {message.recording && (
                <div className="mt-2 rounded-lg border border-hairline/40 p-2 text-[12px]" onClick={(event) => event.stopPropagation()}>
                  <button type="button" onClick={playRecording} className="font-medium text-accent">
                    {recordingPlaying ? "Stop recording" : "Replay recording"}
                  </button>
                  <p className="mt-1">Original transcript: {message.recording.transcript || "(no speech recognized)"}</p>
                  {message.recordingReview?.correction && <p>Correction: {message.recordingReview.correction}</p>}
                  {message.recordingReview?.comment && <p>Note: {message.recordingReview.comment}</p>}
                  {message.translation ? <p>Translation ({message.translation.language}): {message.translation.text}</p> : <p className="text-ink-secondary">Translation not configured</p>}
                  <button type="button" onClick={() => {
                    setReviewCorrection(message.recordingReview?.correction ?? "");
                    setReviewComment(message.recordingReview?.comment ?? "");
                    setReviewOpen(!reviewOpen);
                  }} className="mt-1 text-accent">Correct or add a note</button>
                  {reviewOpen && <div className="mt-2 space-y-2">
                    <label className="block">Correction (keeps the original)
                      <textarea value={reviewCorrection} onChange={(event) => setReviewCorrection(event.target.value)} maxLength={12000} className="mt-1 block w-full rounded border border-hairline bg-inset p-2 text-ink" />
                    </label>
                    <label className="block">Note
                      <textarea value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} maxLength={12000} className="mt-1 block w-full rounded border border-hairline bg-inset p-2 text-ink" />
                    </label>
                    <button type="button" onClick={() => void saveReview()} className="text-accent">Save review</button>
                  </div>}
                  {reviewError && <p role="alert" className="text-danger">{reviewError}</p>}
                </div>
              )}
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
            <MessageBoundary fallbackText={toImessageBody ?? text}>
              {toImessageBody !== null && (
                <div className="mb-1 text-[11px] font-medium text-accent">To iMessage</div>
              )}
              <ChatMarkdown text={voiceSections?.written ?? toImessageBody ?? cleanWritten} />
              {message.role === "bot" && (
                <SpokenSummaryCard
                  messageId={message.id}
                  voiceText={message.voiceText}
                  legacyVoice={voiceSections?.voice}
                />
              )}
            </MessageBoundary>
          )}
        </div>
        {/* trailing placement: the thread's own bot, left-aligned as always.
            Regenerate is only on the newest message, and the reaction bar
            only on text — neither may resize the bubble it hangs off. */}
        {!alignRight && botChrome}
      </div>
      {/* busy-gated so a flag stranded by a server restart shows nothing */}
      {humanTyped && message.queued && bot.busy && (
        <div className="mt-1 flex items-center gap-1.5 pr-1 text-[11px] text-ink-secondary/70">
          <Clock size={11} aria-hidden="true" />
          <span>Queued — sends when this turn finishes</span>
          <button
            type="button"
            onClick={() => dispatch({ type: "interrupt", botId: bot.id })}
            className="ml-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-raised hover:underline"
            title="Interrupt current turn and send this message immediately"
          >
            Steer Now
          </button>
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
      <ReactionChips threadId={bot.threadId} message={message} align={alignRight ? "right" : "left"} />
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
/** One shared empty queue.  See the note at its use site: identity, not
 * contents, is what this is for. */
const NO_QUEUE: ReadonlyArray<{ queueId: string; text: string }> = [];

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
                  {/* This chip is a settled transcript row (emergingId hides
                      the live one), so the face never needs to move — UI1. */}
                  <BotMascot color={comm.withColor} state="happy" size={16} animated={false} />
                  <span className="font-medium truncate" title={tool.name}>{tool.name}</span>
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
                <MentionText text={message.text ?? ""} />
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
          {/* Settled row, same as the expanded chip above — UI1. */}
          <BotMascot color={comm.withColor} state="happy" size={16} animated={false} />
          <span className="max-w-[480px] truncate" title={tool.name}>{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  // everything that is not a bot⇄bot chip is a step in the work, and a step
  // is a log line — see ToolLine for why it stopped being a card
  return <ToolLine message={message} actor={message.from?.name ?? bot.name} threadId={bot.threadId} />;
}

/** A frame of the bot's computer.
 *
 * Live frames arrive over SSE with their pixels inline; a frame that came
 * from a paginated page arrives as a flag and is fetched from its own route
 * when this renders it.  That route is immutable-cached, so the browser
 * holds the bytes instead of the reducer — the difference between a long
 * computer-use thread costing megabytes of JS heap and costing none. */
function ScreenFrame({ src }: { src: string }) {
  return (
    <div className="flex justify-start">
      <img
        src={src}
        alt="Bot's screen"
        loading="lazy"
        decoding="async"
        className="w-fit max-w-[min(42rem,85%)] rounded-2xl border border-hairline/40"
      />
    </div>
  );
}

/** Where this message's pixels live: inline for a live frame, the
 * per-message route for one that was paginated in. */
export function screenFrameSrc(message: Message, threadId: string): string | null {
  if (message.png) return `data:${message.mime ?? "image/png"};base64,${message.png}`;
  if (message.hasImage) return `/api/threads/${threadId}/messages/${message.id}/image`;
  return null;
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
  const items = useMemo(() => {
    // a helper's steps sit under the row that started the helper
    const ordered = nestHelperSteps(messages);
    return summarizeToolCalls ? groupActivityRuns(ordered) : ordered.map((m) => ({ kind: "message" as const, message: m }));
  }, [messages, summarizeToolCalls]);
  // A search hit inside a folded run has to open it: the fold keeps the
  // row out of the DOM, and there is nothing for the scroll to land on.
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === bot.threadId ? focus.messageId : null;
  return (
    <>
      {messages.length === 0 && !bot.busy && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
          {/* The guard above already requires !bot.busy to reach this row,
              so the mascot has nothing to show motion for — UI1. */}
          <BotAvatar bot={bot} state={stateForBot(bot)} size={64} motion="none" motionKey={0} animated={false} />
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
              // a job's end is news, not a step: shown whatever the setting
              if (m.job) return <JobFinishedRow job={m.job} />;
              if (!showToolCalls && !m.comm) return null;
              return <ActivityChip bot={bot} message={m} />;
            }
            case "screen": {
              const src = screenFrameSrc(m, bot.threadId);
              return src ? <ScreenFrame src={src} /> : null;
            }
            default: {
              // Auto-delivered instructions (routine / webhook / resource) are
              // stored as role=system.  Older webhook rows still used
              // role=user; keep those off the blue bubble too.
              const autoDelivered = m.role === "system" || (m.role === "user" && !m.from?.botId);
              // A system work card — however it renders (a parsed
              // webhook/iMessage view, or the generic Scheduled Run card) —
              // needs the same edit-in-place and "‹ i/N ›" version
              // reachability a user Bubble gets: Composer's ArrowUp can set
              // editingId to a system turn-starter, and Regenerate forks a
              // system message the same way it forks a user one
              // (store.branchMessage), so its siblings must stay selectable
              // and its edit state must actually render, not just be armed.
              const delegationView = delegationMessageView(m.role, m.text ?? "", m.from?.name, m.automationSource);
              // Legacy delegation starters were stored as user messages but
              // now render as cards. Keep their editor and branches reachable.
              const cardStarter = m.role === "system" || Boolean(delegationView);
              const systemEditing = cardStarter && editingId === m.id;
              const systemVersions = cardStarter ? messageVersions(bot, m) : [m];
              const systemVersionIndex = systemVersions.findIndex((v) => v.id === m.id);
              const withSystemChrome = (card: ReactNode) => {
                if (systemEditing) {
                  return (
                    <div className="my-0.5 flex justify-start">
                      <BubbleEditor
                        chrome="system"
                        initial={m.text ?? ""}
                        onCancel={onCancelEdit}
                        onSubmit={(text) => onSubmitEdit(m.id, text)}
                      />
                    </div>
                  );
                }
                return (
                  <div className="flex flex-col items-start gap-0.5">
                    {card}
                    {systemVersions.length > 1 && (
                      <div className="flex items-center gap-0.5 pl-1 text-[12px] text-ink-secondary">
                        <button
                          onClick={() =>
                            dispatch({
                              type: "switchBranch",
                              botId: bot.id,
                              messageId: systemVersions[systemVersionIndex - 1].id,
                            })
                          }
                          disabled={systemVersionIndex <= 0 || bot.busy}
                          className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                          type="button"
                          aria-label="Previous Version"
                          title="Previous Version"
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <span className="tabular-nums">
                          {systemVersionIndex + 1}/{systemVersions.length}
                        </span>
                        <button
                          onClick={() =>
                            dispatch({
                              type: "switchBranch",
                              botId: bot.id,
                              messageId: systemVersions[systemVersionIndex + 1].id,
                            })
                          }
                          disabled={systemVersionIndex >= systemVersions.length - 1 || bot.busy}
                          className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
                          type="button"
                          aria-label="Next Version"
                          title="Next Version"
                        >
                          <ChevronRight size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              };
              if (delegationView) {
                return withSystemChrome(
                  <DelegationCard view={delegationView} comm={m.comm} targetBotName={bot.name} />,
                );
              }
              const webhookView = autoDelivered ? webhookMessageView(m.text ?? "") : null;
              if (webhookView) return withSystemChrome(<WebhookCard view={webhookView} />);
              const imessageView = autoDelivered ? imessageMessageView(m.text ?? "") : null;
              if (imessageView) {
                return withSystemChrome(
                  <WebhookCard
                    view={imessageView}
                    icon={<MessageCircle size={14} className="shrink-0 text-ink-secondary/70" aria-hidden="true" />}
                    detailsNoun="Message"
                  />,
                );
              }
              if (m.role === "system") {
                const body = (m.text ?? "").trim();
                const firstLine = body.split("\n").find((line) => line.trim()) ?? "";
                // Headline names what actually fired this — accurate per
                // m.automationSource (falls back to sniffing the resource
                // marker for rows persisted before that field existed), not
                // the hardcoded "Scheduled Run" a manual Run Now or a
                // resource alert would otherwise wear.  Subtitle is the
                // instruction's own first line, same as before.
                // A job's wake says how the job ended, not its id and the
                // words addressed to the bot (those stay under Run Details).
                const jobWake = m.automationSource === "job";
                return withSystemChrome(
                  <WebhookCard
                    view={{
                      headline: automationSourceLabel(m.automationSource, body),
                      subtitle: jobWake
                        ? jobWakeSubtitle(body)
                        : firstLine && firstLine !== "Scheduled Run" ? firstLine.slice(0, 80) : undefined,
                      payload: body || undefined,
                    }}
                    icon={
                      jobWake
                        ? <SquareTerminal size={14} className="shrink-0 text-ink-secondary/70" aria-hidden="true" />
                        : <Clock size={14} className="shrink-0 text-ink-secondary/70" aria-hidden="true" />
                    }
                    detailsNoun="Run Details"
                  />,
                );
              }
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
          }
        })();
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && <DaySeparator at={m.at} />}
            {row}
            {/* what the harness put in front of the model for the turn this
                message started, as quiet rows right under it; gated with the
                tool calls, the other "under the hood" detail */}
            {showToolCalls && m.contextInjections?.length ? (
              <ContextInjectionRows entries={m.contextInjections} threadId={bot.threadId} />
            ) : null}
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
  // a peer bot's reply is `role: "user"` too — "You" belongs only to what
  // the human actually typed
  const sender =
    pinned.role === "user" && !pinned.from?.botId ? "You" : (pinned.from?.name ?? bot.name);
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
          <span className="truncate text-[12.5px] text-ink-secondary" title={text}>{text}</span>
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
  // the open thread's task: its banked usage and timing feed the footer chips
  const activeTask = bot.tasks?.find((t) => t.threadId === bot.threadId);
  // Chat or Trajectory, remembered per thread.  The chat pane below stays
  // mounted (just not shown) in Trajectory, so its scroll position, draft and
  // streaming state are exactly where they were when the person switches back.
  const [threadView, setThreadView] = useThreadView(bot.threadId);
  const trajectoryOpen = threadView === "trajectory";

  const stream = useStreaming();
  const streaming = stream.streaming[bot.threadId];
  const reasoning = stream.reasoning[bot.threadId];
  const provisioning = state.provisioning[bot.id];
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  // The header avatar is the one ChatView mascot that can be on screen while
  // its bot is actually working — animate only then, and never behind a
  // hidden tab, the same rule the roster and GroupView already apply (UI1).
  const pageVisible = usePageVisible();
  const [findOpen, setFindOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [composerHeight, setComposerHeight] = useState(140);
  const composerContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = composerContainerRef.current;
    if (!el) return;
    const update = () => {
      const height = Math.round(el.offsetHeight);
      if (height > 0) setComposerHeight((prev) => (prev !== height ? height : prev));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => update());
    observer.observe(el);
    return () => observer.disconnect();
  }, [bot.id]);
  useEffect(() => setFindOpen(false), [bot.threadId]);
  useEffect(() => setReplyTo(null), [bot.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        // The conversation is not on screen in Trajectory: search the steps
        // there instead of arming a find bar the person cannot see.
        if (trajectoryOpen) requestTrajectorySearch();
        else setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, [trajectoryOpen]);

  // only the active branch is rendered; forks stay reachable via ‹ › nav
  //
  // NO_QUEUE, not `?? []`: a fresh literal is a new identity every render, so
  // it invalidated the `messages` memo below, which invalidated the window,
  // which made `MessagesList` — memoized precisely so a streaming frame does
  // not re-render a hundred settled rows — re-render all of them anyway.  A
  // thread with nothing queued is the normal case, so this was the normal
  // cost.
  const pendingQueued = state.pendingQueued[bot.threadId] ?? NO_QUEUE;
  const serverMessages = useMemo(() => visibleMessages(bot), [bot]);
  const messages = useMemo(() => {
    if (!pendingQueued.length) return serverMessages;
    const queued: Message[] = pendingQueued.map((entry) => ({
      id: entry.queueId,
      at: entry.at,
      role: "user",
      kind: "text",
      text: entry.text,
      queued: true,
      queueId: entry.queueId,
    }));
    return [...serverMessages, ...queued];
  }, [serverMessages, pendingQueued]);
  const latestServerError = useMemo(() => latestTurnErrorMessage(serverMessages), [serverMessages]);
  const errorBranchKey = useMemo(() => turnErrorBranchKey(bot.messages, serverMessages), [bot.messages, serverMessages]);
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
  // scrollback beyond what this client loaded — the desktop hydrates a tail
  // and pulls earlier pages on demand, like the iOS companion
  const moreOnServer = state.hasMore[bot.threadId] === true;
  const loadingEarlier = state.loadingEarlier[bot.threadId] === true;
  // a full-thread scan; unmemoized it ran on every render of every frame
  const hiddenCount = useMemo(
    () => hiddenDisplayCount(messages, startIndex, { includeToolCalls, summarizeToolCalls }),
    [messages, startIndex, includeToolCalls, summarizeToolCalls],
  );

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
  // Regenerate needs whatever actually started the last turn — a person's
  // message, or (on an automation-only thread) the routine/webhook/resource
  // instruction stored as role="system".  Restricting this to "user" made
  // Regenerate a no-op on a fresh automation-only thread, and dispatch a
  // stale older human message instead of the automation prompt on a reused
  // one.
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => (m.role === "user" || m.role === "system") && m.kind === "text"),
    [messages],
  );

  // Show the live reply above the mascot while tokens arrive.  The settled
  // message takes over when the turn finishes.
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
  const presenceVisible = waiting || popping !== null || Boolean(streaming);
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

  // Opening a conversation lands at the newest message.
  //
  // The follow-the-bottom effect below only fires while `follow` is armed and
  // the row count changes, so switching TASKS — same bot, different thread —
  // could open a conversation mid-scrollback: `bot.id` had not changed, so
  // follow was never re-armed, and a new thread with the same row count as
  // the old one never triggered a scroll at all.  Opening is an explicit
  // jump, in a layout effect so it happens before the first paint, with one
  // more pass on the next frame for content that lays out late (markdown,
  // images, a code block measuring itself).
  useLayoutEffect(() => {
    setBottomFollow(true);
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    previousScrollTop.current = el.scrollTop;
    const frame = requestAnimationFrame(() => {
      const settled = scrollRef.current;
      if (!settled || !followRef.current) return;
      settled.scrollTop = settled.scrollHeight;
      previousScrollTop.current = settled.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity only:
    // re-running on every message would fight the reader's own scrolling
  }, [bot.id, bot.threadId, setBottomFollow]);

  // A search result may be hundreds of rows before the mounted tail. Open a
  // bounded window around it first; useFocusMessage then scrolls and flashes
  // the row after React commits that window.
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    const focus = state.focusMessage;
    if (!focus || focus.consumed || focus.threadId !== bot.threadId || appliedFocus.current === focus.nonce) return;
    const targetIndex = messages.findIndex((message) => message.id === focus.messageId);
    // A hit older than the hydrated tail is not loaded yet.  Walk back a
    // page at a time — `appliedFocus` stays unset, so this effect runs again
    // when the page lands and either finds the row or asks for the next one.
    if (targetIndex < 0) {
      if (state.hasMore[bot.threadId] === true && state.loadingEarlier[bot.threadId] !== true) {
        dispatch({ type: "loadEarlier", threadId: bot.threadId });
      }
      return;
    }
    appliedFocus.current = focus.nonce;
    const range = focusWindowRange(messages.length, targetIndex);
    setBottomFollow(false);
    setTranscriptWindow({ key: transcriptKey, start: range.start, end: range.end });
  }, [
    bot.threadId,
    dispatch,
    messages,
    setBottomFollow,
    state.focusMessage,
    state.hasMore,
    state.loadingEarlier,
    transcriptKey,
  ]);
  useFocusMessage(bot.threadId, messages.length > 0);

  // deps track the FULL messages.length, so expanding the window (which only
  // changes windowedMessages) can never re-trigger this bottom scrollTo
  //
  // Not while the pane is hidden behind the Trajectory view: a hidden box has
  // no height, so "scroll to the bottom" would pin the offset to zero.  Coming
  // back re-runs this, and a reader who was following lands on the newest.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followRef.current || trajectoryOpen) return;
    el.scrollTo({ top: el.scrollHeight });
    previousScrollTop.current = el.scrollTop;
  }, [bot.id, bot.threadId, messages.length, streaming, reasoning, bot.busy, follow, composerHeight, trajectoryOpen]);

  // Expanding prepends rows: capture the height first, then after the commit
  // shift scrollTop by the growth so the message under the cursor stays put
  // (browser scroll anchoring is disabled on this container).
  const preExpandHeight = useRef<number | null>(null);
  const showEarlier = () => {
    preExpandHeight.current = scrollRef.current?.scrollHeight ?? null;
    // expanding means reading scrollback — never let a mid-expand stream
    // event pin the viewport back to the bottom
    setBottomFollow(false);
    // Already mounting the oldest message this client holds: the next page
    // has to come off the server.  The window boundary stays where it is —
    // the arriving page prepends, so the same click keeps walking back
    // whether the messages were already here or not.
    if (startIndex === 0) {
      if (moreOnServer && !loadingEarlier) dispatch({ type: "loadEarlier", threadId: bot.threadId });
      return;
    }
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
  //
  // Not while Trajectory is showing: Home and PageUp there belong to the step
  // list, and must not turn off follow on a chat that is hidden behind it.
  useEffect(() => {
    if (trajectoryOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "PageUp" || (e.key === "Home" && !(e.target instanceof HTMLTextAreaElement))) {
        setBottomFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottomFollow, trajectoryOpen]);

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
              animated={Boolean(bot.busy) && pageVisible}
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
          <ThreadViewSwitch view={threadView} onChange={setThreadView} />
          {/* Always here, so the switch beside it never slides under the pointer:
              in Trajectory the same magnifier searches the steps. */}
          <button
            onClick={() => (trajectoryOpen ? requestTrajectorySearch() : setFindOpen((open) => !open))}
            aria-label={trajectoryOpen ? "Search Steps" : "Find in Conversation"}
            aria-pressed={trajectoryOpen ? undefined : findOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              findOpen && !trajectoryOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={trajectoryOpen ? "Search Steps (⌘F)" : "Find in Conversation (⌘F)"}
          >
            <Search size={18} />
          </button>
          {/* Background jobs, left of Stop.  Stop ends the turn, never a job. */}
          <JobsMenu threadId={bot.threadId} />
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
          {/* Quick toggle: speak replies aloud */}
          <label
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-hairline/40 px-2.5 py-1 text-[13px] transition-colors cursor-pointer select-none",
              COMPACT_BUBBLE,
              (bot.speechDevices ? bot.speechDevices.includes("mac") : bot.speakReplies)
                ? "bg-accent/15 border-accent/40 text-accent font-medium hover:bg-accent/25"
                : "bg-raised/60 text-ink-secondary hover:bg-raised hover:text-ink",
            )}
            title={
              (bot.speechDevices ? bot.speechDevices.includes("mac") : bot.speakReplies)
                ? "Speak replies aloud is ON (click to turn off)"
                : "Speak replies aloud is OFF (click to turn on)"
            }
          >
            <input
              type="checkbox"
              checked={Boolean(bot.speechDevices ? bot.speechDevices.includes("mac") : bot.speakReplies)}
              onChange={(e) => {
                const next = e.target.checked;
                dispatch({
                  type: "updateBot",
                  botId: bot.id,
                  patch: {
                    speakReplies: next,
                    speechDevices: next ? ["mac"] : [],
                  },
                });
                void api(`/api/bots/${bot.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    speakReplies: next,
                    speechDevices: next ? ["mac"] : [],
                  }),
                });
              }}
              className="size-3.5 rounded border-hairline text-accent accent-accent focus:ring-accent cursor-pointer"
            />
            <span className="@max-4xl/chathead:hidden">Speak replies aloud</span>
          </label>
          <ModelPicker bot={bot} />
          <CallButton bot={bot} />
          <ChatHeaderOverflowMenu bot={bot} />
        </div>
      </div>

      <ThreadTabs bot={bot} />

      {findOpen && !trajectoryOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}

      
      {/* Pinned message banner */}
      {!trajectoryOpen && (
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
      )}

      {showToolCallsEnabled(state.config) && !trajectoryOpen && <TaskTimeline messages={messages} busy={bot.busy ?? false} />}

      {/* Trajectory: what the bot did and where the time went.  Keyed by
          thread so its search, expanded steps and live tail never carry over. */}
      {trajectoryOpen && (
        <TrajectoryView
          key={bot.threadId}
          threadId={bot.threadId}
          messages={serverMessages}
          running={Boolean(bot.busy)}
          knownTurns={activeTask?.usage?.turns}
        />
      )}

      {/* Messages + composer share one pane so bubbles scroll into the pill
          instead of dying on a rectangular clip above a black dock.
          `@container/chat`: the hover chrome beside every bubble reads this
          pane's width to decide stacked-vs-single-row (bubble-metrics.ts).
          Side effect worth knowing about: container-size containment makes
          this the containing block for any `fixed`-positioned descendant —
          today that's only ChatMarkdown's file-link menu backdrop, which
          still covers the whole transcript, just not the sidebar/header. */}
      <div className={cn("relative min-h-0 flex-1 @container/chat", trajectoryOpen && "hidden")}>
      <TurnErrorAnnouncement
        key={`${bot.threadId}:${errorBranchKey}`}
        latestMessage={latestServerError}
        streamTailId={serverMessages.at(-1)?.id}
      />
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
          className="flex w-full flex-col gap-3"
          style={{ paddingBottom: `${Math.max(composerHeight + 24, 224)}px` }}
          role="log"
          aria-live="polite"
          aria-label={`Conversation with ${bot.name}`}
        >
          {(hiddenCount > 0 || moreOnServer) && (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                disabled={loadingEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
              >
                {loadingEarlier
                  ? "Loading earlier messages…"
                  : hiddenCount > 0
                    ? `Show earlier messages (${hiddenCount} more)`
                    : "Load earlier messages"}
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
            engine={state.instances.find((i) => i.instanceId === (bot.activeModelSelection ?? bot.modelSelection).instanceId)}
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
              <BotMascot
                color={bot.color}
                state={toolInFlight ? "working" : "thinking"}
                size={36}
                forward={false}
                lookAround={1}
                trackPointer={false}
              />
            }
            visible={presenceVisible}
            startedAt={bot.activityStartedAt}
            label={activityLabel}
            answering={popping !== null || Boolean(streaming)}
            modelMark={presenceModel ? <ProviderMark driverKind={presenceModel.driverKind} model={presenceModel.model} size={14} /> : undefined}
            modelName={presenceModel?.name}
          >
            {/* Live streaming text: shown while the driver is still
             * emitting tokens, before the settled message lands.  Without
             * this, a 30-second turn reads as a spinner with no signal
             * for the entire duration — the assistant is "working" but
             * the user cannot see what they are working on.  When the
             * settled `popping` message arrives it takes over and animates
             * into place, so we never render both at once. */}
            {!popping && streaming ? (
              <div className={cn(BUBBLE_WIDTH, "rounded-2xl bg-card px-4 py-2.5 text-[15px] leading-relaxed text-ink")}>
                <MessageBoundary fallbackText={streaming}>
                  <ChatMarkdown text={streaming} streaming />
                </MessageBoundary>
                <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-ink-secondary/60 align-middle" aria-hidden />
              </div>
            ) : null}
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

      {/* keyed by bot: a draft belongs to the conversation it was typed in,
          so switching bots starts from an empty composer instead of carrying
          the previous bot's half-written message over. ArrowUp-to-edit is
          gated on busy like the pencil button — editing rewinds the thread,
          which a live turn forbids (the server 409s it). */}
      <div
        ref={composerContainerRef}
        className="absolute inset-x-0 bottom-0 z-[2] flex flex-col items-center"
      >
      {!follow && (
        <button
          onClick={jumpToLatest}
          aria-label="Jump to Latest Messages"
          className="animate-pop-in relative z-10 mb-2 flex items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
        >
          <ArrowDown size={13} /> Jump to Latest
        </button>
      )}
      <div className="w-full">
      <Composer
        key={bot.id}
        bot={bot}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        onRestoreReply={(message) => setReplyTo((current) => current ?? message)}
        onEditLast={lastUserMessage && !bot.busy ? () => setEditingId(lastUserMessage.id) : undefined}
      />
      <ThreadStatsBar stats={activeTask?.stats} usage={activeTask?.usage} />
      </div>
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
              <div className="truncate font-mono text-[11px] text-ink-secondary" title={folderName ?? "Private bot workspace"}>
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

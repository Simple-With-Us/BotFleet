import { track } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, Clock, Hand, Mic, Paperclip, ShieldCheck, Square, Users, X, Zap, Hash, AppWindow } from "lucide-react";
import { useStore, visibleMessages, type Bot, type Group, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { useComposerDraft } from "@/lib/drafts";
import { BotMascot } from "./Avatar";
import { ComposerAttachments, pathForFile } from "./ComposerAttachments";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import {
  appendPastedText,
  composeMessage,
  filesFromClipboard,
  imageAttachmentFromFile,
  intakeFiles,
  isLongPaste,
  pasteAttachment,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { normalizeState } from "@/lib/mascot";
import { groupComposerHint, roomRespondersForComposer } from "@/lib/group-routing";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { ReplyQuote } from "./ReplyQuote";
import { instanceSupportsLocalComputer } from "@/lib/local-computer";
import { requiresLocalAutoConsent } from "../../shared/local-auto-consent";
import { resolveRoomLabels } from "../../shared/terminology";
import { readCachedInventory } from "@/lib/connected-apps-cache";
import {
  autocompleteQueryAt,
  getAutocompleteCandidates,
  applyAutocomplete,
  type AutocompleteChoice,
} from "@/lib/composer-autocomplete";

function PermissionModeSelector({ bot, onSetAuto }: { bot: Bot; onSetAuto: (auto: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  const mode = bot.autoApprove ? "auto" : "ask";
  const Icon = mode === "auto" ? ShieldCheck : Hand;
  const label = mode === "auto" ? "Approve for Me" : "Ask for Approval";

  return (
    <div className="relative flex items-center" ref={wrapperRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-hairline/20 bg-transparent px-3 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <Icon size={14} className="opacity-70" />
        {label}
      </button>

      {open && (
        <div
          role="menu"
          aria-label={`Permission mode for ${bot.name}`}
          className="absolute bottom-full left-0 z-30 mb-2 w-80 overflow-hidden rounded-xl border border-hairline/40 bg-raised shadow-lg"
        >
          <div className="border-b border-hairline/20 px-4 py-3 text-[13px] font-medium text-ink-secondary">
            How should {bot.name} actions be approved?
          </div>
          <div className="flex flex-col py-1">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={mode === "ask"}
              onClick={() => {
                onSetAuto(false);
                setOpen(false);
              }}
              className="flex items-start gap-3 px-4 py-3 text-left hover:bg-raised-hover"
            >
              <Hand size={16} className="mt-0.5 shrink-0 opacity-70" />
              <div className="flex w-full flex-col gap-0.5">
                <div className="flex items-center justify-between text-[14px] text-ink">
                  Ask for Approval
                  {mode === "ask" && <Check size={14} />}
                </div>
                <div className="text-[13px] text-ink-secondary">Ask before actions that need your permission</div>
              </div>
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={mode === "auto"}
              onClick={() => {
                onSetAuto(true);
                setOpen(false);
              }}
              className="flex items-start gap-3 px-4 py-3 text-left hover:bg-raised-hover"
            >
              <ShieldCheck size={16} className="mt-0.5 shrink-0 opacity-70" />
              <div className="flex w-full flex-col gap-0.5">
                <div className="flex items-center justify-between text-[14px] text-ink">
                  Approve for Me
                  {mode === "auto" && <Check size={14} />}
                </div>
                <div className="text-[13px] text-ink-secondary">
                  Keep going automatically; destructive and sensitive actions still ask
                </div>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Renders the editable message composer and its pending attachments. */
export function Composer({
  bot,
  group,
  members,
  onEditLast,
  replyTo,
  onClearReply,
  locked = false,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  replyTo?: Message | null;
  onClearReply?: () => void;
  /** New rooms keep the composer inert until their setup is saved or skipped. */
  locked?: boolean;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // Unified target: a 1:1 bot thread or a room. In a room the @ picker
  // offers members plus @everyone; explicit mentions override the room's
  // configured default responder.
  const busy = group ? Boolean(group.busyBotId) : Boolean(bot?.busy);
  // an engine with a live session takes a message INTO the running turn;
  // for those the composer never locks — the server steers instead of 409
  const canSteer =
    !group && Boolean(bot) && state.instances.find((i) => i.instanceId === bot!.modelSelection.instanceId)?.capabilities?.queueing === true;
  // a pending approval blocks the prompt until it is answered
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  // the VISIBLE branch only — an approval left on a branch you edited away
  // from must not keep blocking the composer
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  const approvalBot = group
    ? members?.find((member) => member.id === approval?.message.from?.botId) ??
      members?.find((member) => member.id === group.busyBotId)
    : bot;
  const busyName = group
    ? (members?.find((b) => b.id === group.busyBotId)?.name ?? "A bot")
    : (bot?.name ?? "The bot");
  // Per-thread draft: switching bots unmounts this component, so both the
  // text and its attachment chips have to outlive it (see lib/drafts).
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    group ? `group:${group.id}:${group.threadId}` : `bot:${bot?.id ?? ""}`,
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => setAttachments((prev) => [...prev, ...next]),
    [setAttachments],
  );
  const removeAttachment = useCallback(
    (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id)),
    [setAttachments],
  );
  const displayPasteInChatBox = useCallback(
    /** Moves one pasted attachment into the editable draft and restores focus. */
    function displayPasteInChatBox(attachment: PasteAttachment) {
      const nextText = appendPastedText(text, attachment.text);
      setText(nextText);
      setAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      setCaret(nextText.length);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(nextText.length, nextText.length);
      });
    },
    [text, setText, setAttachments],
  );
  const [recording, setRecording] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null); // Esc'd this @
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // what was typed before the mic went on — partials append after it
  const baseText = useRef("");

  // image paste is offered only when every bot that will actually answer
  // can open one. sendGroup routes to mentions, else the room default —
  // `members.some` would let a mixed room send <attached-image> to Grok.
  const botSupportsImages = (candidate?: Bot) =>
    Boolean(
      candidate &&
        state.instances.find((i) => i.instanceId === candidate.modelSelection.instanceId)?.capabilities?.images,
    );
  const imageTargetsSupport = (message: string) => {
    if (!group) return botSupportsImages(bot);
    const responders = roomRespondersForComposer(message, members ?? [], group);
    return responders.length > 0 && responders.every(botSupportsImages);
  };
  const engineSupportsImages = imageTargetsSupport(text);

  // ── Autocomplete picker (@ for bots, # for apps/channels/etc) ──
  const triggerInfo = autocompleteQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!triggerInfo || triggerInfo.start === dismissedAt) return [];
    const connectedApps = readCachedInventory()?.services;
    const terminology = resolveRoomLabels(state.config?.terminology);
    return getAutocompleteCandidates(triggerInfo, {
      bots: state.bots,
      groups: state.groups,
      routines: state.routines,
      connectedApps,
      currentBotId: bot?.id,
      group,
      members,
      terminologySingular: terminology.singular,
    });
  }, [triggerInfo, dismissedAt, state.bots, state.groups, state.routines, state.config?.terminology, bot?.id, group, members]);
  const pickerOpen = candidates.length > 0;

  useEffect(() => setHighlight(0), [triggerInfo?.start, triggerInfo?.query]);

  // one line at rest, then grow with the draft — hard cap at six lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 24;
    const cap = line * 6;
    el.style.height = "0px";
    el.style.height = `${Math.max(line, Math.min(el.scrollHeight, cap))}px`;
  }, [text]);

  const pickCandidate = (choice: AutocompleteChoice) => {
    if (!triggerInfo) return;
    const { text: nextText, caret: newCaret } = applyAutocomplete(text, caret, triggerInfo, choice);
    setText(nextText);
    setCaret(newCaret);
    // picking completes this tag — close the popup so the next Enter sends
    setDismissedAt(triggerInfo.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  // Rooms hold one message client-side while a member speaks; it auto-sends
  // the moment the room settles. 1:1 mid-turn sends still POST (the harness
  // queue), but stay off the transcript until drain — the chip here is the
  // pending row so they cannot become the active leaf mid-turn.
  const [queued, setQueued] = useState<{ text: string; replyToId?: string } | null>(null);
  const pendingChip = group
    ? queued?.text
    : (bot ? state.pendingQueued?.[bot.threadId]?.at(-1)?.text : undefined);
  // a chip on its own is a message: the send control has to appear for it
  const fileInput = useRef<HTMLInputElement>(null);
  const [autoWarn, setAutoWarn] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  // Auto mode belongs to one bot; a room has several, each with its own.
  const autoBot = group ? undefined : bot;
  const pickFiles = async (picked: FileList | null) => {
    if (!picked?.length) return;
    const { attachments: added, notice } = await intakeFiles(Array.from(picked), {
      allowImages: engineSupportsImages,
      getPath: pathForFile,
      uploadImage: imageAttachmentFromFile,
    });
    if (added.length) addAttachments(added);
    // Keep file-specific failures beside the attachments. A successful
    // overlapping intake must not erase an earlier failure before it is read.
    if (notice) setAttachmentNotice(notice);
  };
  const setAuto = (auto: boolean) => {
    if (!autoBot) return;
    // Turning it on for a bot that drives THIS computer is the one case that
    // has to be acknowledged first. The flag the dialog sends is stripped by
    // the reducer rather than stored, so — exactly like the settings panel —
    // the warning is shown on every switch-on, not just the first.
    if (auto && !autoBot.autoApprove && requiresLocalAutoConsent(
      autoBot.computers,
      state.config?.botDefaults?.computers,
      state.config?.botDefaults?.allowedComputers,
      {
        hostPlatform: capabilities.host.platform,
        providerSupportsLocal: instanceSupportsLocalComputer(state.instances, autoBot),
      },
    )) {
      setAutoWarn(true);
      return;
    }
    dispatch({ type: "updateBot", botId: autoBot.id, patch: { autoApprove: auto } });
  };

  const hasContent = Boolean(text.trim()) || attachments.length > 0;
  const send = (opts?: { steerNow?: boolean }) => {
    if (locked) return;
    if (attachments.some((attachment) => attachment.kind === "image") && !imageTargetsSupport(text)) {
      dispatch({ type: "error", message: "The selected responder does not support image attachments." });
      return;
    }
    const t = composeMessage(text, attachments);
    if (!t) return;
    if (busy && group) {
      if (opts?.steerNow) {
        dispatch({ type: "interruptGroup", groupId: group.id });
        dispatch({ type: "sendGroup", groupId: group.id, text: t, replyToId: replyTo?.id });
      } else {
        setQueued({ text: t, replyToId: replyTo?.id });
      }
      setText("");
      setAttachments([]);
      onClearReply?.();
      return;
    }
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, text: t, replyToId: replyTo?.id });
      track("message_sent", { room: true });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, text: t, replyToId: replyTo?.id });
      if (busy && opts?.steerNow) {
        dispatch({ type: "interrupt", botId: bot.id });
      }
      track("message_sent", { driver: bot.modelSelection?.instanceId, queued: busy && !canSteer, steerNow: opts?.steerNow });
    }
    setText("");
    setAttachments([]);
    onClearReply?.();
  };
  useEffect(() => {
    if (busy || !queued) return;
    if (group) {
      if (queued.text.includes("<attached-image ") && !imageTargetsSupport(queued.text)) {
        dispatch({ type: "error", message: "The selected responder does not support image attachments." });
        setQueued(null);
        return;
      }
      dispatch({ type: "sendGroup", groupId: group.id, text: queued.text, replyToId: queued.replyToId });
      track("message_sent", { room: true, queued: true });
    }
    setQueued(null);
  }, [busy, queued, group, members, state.instances, dispatch]);

  // native dictation: partials stream into the input while the Swift
  // helper runs; the final transcript stays in the box, ready to edit/send
  useEffect(() => {
    if (!recording) return;
    const bridge = window.ogb;
    if (!bridge) {
      setRecording(false);
      return;
    }
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        setText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code }) => {
      setRecording(false);
      if (code === 2) {
        setSpeechError("Dictation is only available on macOS for now.");
      } else if (code === 1) {
        setSpeechError(
          "Dictation needs Microphone + Speech Recognition access — System Settings → Privacy & Security.",
        );
      }
    });
    void bridge.speechStart();
    return () => {
      offTranscript();
      offEnd();
      void bridge.speechStop();
    };
  }, [recording]);

  const toggleMic = () => {
    if (!capabilities.dictation.available || !window.ogb) {
      setSpeechError("Dictation isn't available in this build.");
      return;
    }
    baseText.current = text.trim();
    setRecording((r) => !r);
  };


  useEffect(() => {
    const onFocusComposer = () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      // Move to end of text if already has text
      if (el.value.length > 0) {
        el.setSelectionRange(el.value.length, el.value.length);
      }
    };
    window.addEventListener("focus-composer", onFocusComposer);
    return () => window.removeEventListener("focus-composer", onFocusComposer);
  }, []);

  useEffect(() => {
    // Automatically focus the composer when opening or switching to a bot, channel, or task
    const el = inputRef.current;
    if (!el) return;
    const active = document.activeElement;
    if (active && active !== el && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) {
      return;
    }
    el.focus();
    if (el.value.length > 0) {
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [bot?.id, group?.id, bot?.threadId]);

  useEffect(() => {
    const onGlobalPaste = (e: ClipboardEvent) => {
      // Skip other editables (Search, Settings, CommandPalette, etc.) so file paste stays local.
      // Composer textarea (inputRef) and pastes outside any text field still run file intake;
      // filesFromClipboard returns [] for text-only clips, so text paste stays in textarea onPaste.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        target !== inputRef.current &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      const files = filesFromClipboard(e.clipboardData);
      if (files.length > 0) {
        e.preventDefault();
        void (async () => {
          const { attachments: added, notice } = await intakeFiles(files, {
            allowImages: engineSupportsImages,
            getPath: pathForFile,
            uploadImage: imageAttachmentFromFile,
          });
          if (added.length) addAttachments(added);
          if (notice) setAttachmentNotice(notice);
        })();
      }
    };
    window.addEventListener("paste", onGlobalPaste);
    return () => window.removeEventListener("paste", onGlobalPaste);
  }, [engineSupportsImages, addAttachments]);

  return (
    <div className="pointer-events-none relative px-5 pb-3">
      <div
        aria-hidden
        className="pointer-events-none h-10 bg-gradient-to-t from-app to-transparent"
      />
      <div className="pointer-events-auto relative w-full overflow-hidden rounded-3xl border border-hairline/50 bg-raised shadow-[0_-10px_28px_rgba(20,24,32,0.08)]">
      <div className="px-3 pb-2 pt-2">
      {speechError && (
        <div className="mb-2 w-full rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          {speechError}
        </div>
      )}
        {pendingChip && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12.5px] text-ink-secondary">
            <Clock size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={`Queued — sends when ${busyName} finishes: “${pendingChip}”`}>
              Queued — sends when {busyName} finishes: “{pendingChip}”
            </span>
            <button
              type="button"
              onClick={() => {
                if (group) {
                  dispatch({ type: "interruptGroup", groupId: group.id });
                } else if (bot) {
                  dispatch({ type: "interrupt", botId: bot.id });
                }
              }}
              className="rounded px-2 py-0.5 text-[11.5px] font-medium text-accent hover:bg-raised hover:underline"
              title="Interrupt current turn and send queued messages immediately"
            >
              Steer Now
            </button>
            <button
              type="button"
              onClick={() => {
                if (group) {
                  setQueued(null);
                  return;
                }
                if (!bot) return;
                for (const entry of state.pendingQueued?.[bot.threadId] ?? []) {
                  dispatch({ type: "cancelQueued", botId: bot.id, queueId: entry.queueId });
                }
              }}
              aria-label="Cancel Queued Message"
              title="Cancel Queued Message"
              className="flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
            >
              <X size={13} strokeWidth={2.5} />
            </button>
          </div>
        )}
        {pickerOpen && (
          <div
            role="listbox"
            aria-label={triggerInfo?.trigger === "@" ? "Tag a Bot" : "Link an App or Channel"}
            className="absolute bottom-full left-2 z-20 mb-2 w-80 max-h-72 overflow-y-auto rounded-xl border border-hairline/40 bg-raised shadow-lg"
          >
            <div className="border-b border-hairline/20 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-secondary">
              {triggerInfo?.trigger === "@" ? "Bots" : "Apps & Channels"}
            </div>
            {candidates.map((item, i) => (
              <button
                key={item.id}
                role="option"
                aria-selected={i === highlight}
                onClick={() => pickCandidate(item)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                {item.kind === "bot" ? (
                  item.bot ? (
                    <BotMascot
                      color={item.bot.color}
                      state={normalizeState(item.bot.mascotExpression) ?? "happy"}
                      size={24}
                    />
                  ) : (
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary">
                      <Users size={14} aria-hidden="true" />
                    </span>
                  )
                ) : item.kind === "channel" ? (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary">
                    <Hash size={14} aria-hidden="true" />
                  </span>
                ) : item.kind === "routine" ? (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-accent">
                    <Zap size={14} aria-hidden="true" />
                  </span>
                ) : (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-accent">
                    <AppWindow size={14} aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[14px] font-medium text-ink" title={item.name}>
                      {triggerInfo?.trigger}{item.name}
                    </span>
                  </div>
                  {item.description && (
                    <div className="truncate text-[11.5px] text-ink-secondary" title={item.description}>
                      {item.description}
                    </div>
                  )}
                </div>
                <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10.5px] font-medium text-ink-secondary border border-hairline/30">
                  {item.badge}
                </span>
              </button>
            ))}
          </div>
        )}
        {/* An approval takes over the composer: you answer it before you
            can type again, so a waiting bot is impossible to miss. */}
        {approval && (
          <div className="mb-2 overflow-hidden rounded-2xl border border-accent/40 bg-card">
            <PendingApprovalPanel pending={approval} count={approvals.length} index={0} />
            <PendingApprovalActions
              pending={approval}
              threadId={threadId}
              bot={approvalBot}
              onCancelTurn={() => {
                if (group) dispatch({ type: "interruptGroup", groupId: group.id });
                else if (bot) dispatch({ type: "interrupt", botId: bot.id });
              }}
            />
          </div>
        )}
        {replyTo && (
          <div className="mb-2 px-1">
            <ReplyQuote
              message={replyTo}
              fallbackName={bot?.name}
              onClear={onClearReply}
            />
          </div>
        )}
        <ComposerAttachments
          items={attachments}
          onAdd={addAttachments}
          onRemove={removeAttachment}
          onDisplayInChatBox={displayPasteInChatBox}
          allowImages={engineSupportsImages}
          notice={attachmentNotice}
          onNotice={setAttachmentNotice}
        />
        <div className="relative grid grid-cols-[auto_1fr_auto] items-center gap-x-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void pickFiles(e.target.files);
              // same file twice in a row still fires onChange
              e.target.value = "";
            }}
          />
          {!locked && (
            <div className="col-start-1 row-start-2 mt-1 flex items-center gap-1">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                aria-label="Attach a File"
                title="Attach a File"
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink"
              >
                <Paperclip size={17} />
              </button>
              {autoBot && <PermissionModeSelector bot={autoBot} onSetAuto={setAuto} />}
            </div>
          )}
          <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
          }}
          onPaste={(e) => {
            // rely on onGlobalPaste for files to prevent double-intake
            const pasted = e.clipboardData?.getData("text/plain") || e.clipboardData?.getData("text") || e.clipboardData?.getData("text/html");
            if (!pasted || !isLongPaste(pasted)) {
              // auto-grow on normal text paste
              setTimeout(() => {
                if (inputRef.current) {
                  inputRef.current.style.height = "0px";
                  inputRef.current.style.height = inputRef.current.scrollHeight + "px";
                }
              }, 0);
              return;
            }
            e.preventDefault();
            // Preserve native paste replacement semantics: if text was
            // selected, the attachment replaces that selection.
            const start = e.currentTarget.selectionStart;
            const end = e.currentTarget.selectionEnd;
            if (start !== end) {
              setText(`${text.slice(0, start)}${text.slice(end)}`);
              setCaret(start);
            }
            setAttachments((prev) => [...prev, pasteAttachment(pasted)]);
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (pickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickCandidate(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(triggerInfo?.start ?? null);
                return;
              }
            }
            // an empty composer + ArrowUp = edit your last message (like a chat app)
            if (e.key === "ArrowUp" && !hasContent && onEditLast) {
              e.preventDefault();
              onEditLast();
              return;
            }
            // Shift+Enter inserts a newline; plain Enter sends; Alt/Cmd+Enter steers immediately when busy
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (busy && !canSteer && (e.altKey || e.metaKey)) {
                send({ steerNow: true });
              } else {
                send();
              }
            }
            if (e.key === "Escape" && recording) setRecording(false);
          }}
          disabled={Boolean(approval) || locked}
          placeholder={
            locked
              ? "Finish room setup to start chatting"
              : approval
              ? "Answer the approval above to continue"
              : recording
              ? "Listening…"
              : busy && canSteer
                ? `${busyName} is working — Enter sends this into the running turn`
              : busy
                ? group
                  ? `${busyName} is working — Enter queues your message`
                  : `${busyName} is working — sends when this turn finishes`
                : group
                  ? `Message ${group.name} — ${groupComposerHint(group, members ?? [])}`
                  : `Message ${bot?.name ?? ""}`
          }
          aria-label={`Message ${group ? group.name : (bot?.name ?? "")}`}
            className="col-span-full row-start-1 max-h-[9rem] min-h-6 w-full resize-none overflow-y-auto self-center bg-transparent px-1 py-1 text-[15px] leading-6 text-ink placeholder:italic placeholder:text-ink-secondary focus:outline-none"
          />
          <div className="col-start-3 row-start-2 mt-1 flex items-center gap-1">
          {busy && !locked && (
          <button
            onClick={() => {
              if (group) dispatch({ type: "interruptGroup", groupId: group.id });
              else if (bot) dispatch({ type: "interrupt", botId: bot.id });
            }}
            aria-label="Stop This Turn"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
            title="Stop"
          >
            <Square size={14} className="fill-current" />
          </button>
        )}
        {!locked && !busy && !hasContent && capabilities.dictation.available && (
          <button
            onClick={toggleMic}
            aria-label={recording ? "Stop Dictation" : "Start Dictation"}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
            title={recording ? "Stop Dictation (Esc)" : "Dictate"}
          >
            <Mic size={18} />
          </button>
        )}
        {hasContent && !locked && busy && !canSteer && (
          <button
            type="button"
            onClick={() => send({ steerNow: true })}
            aria-label="Steer Now (send and interrupt current turn)"
            title="Steer Now — send message and interrupt current turn immediately (Alt+Enter)"
            className="flex h-8 items-center gap-1 rounded-full bg-accent px-2.5 text-[12px] font-medium text-white shadow-sm hover:brightness-110"
          >
            <Zap size={13} className="fill-current" />
            <span>Steer Now</span>
          </button>
        )}
        {hasContent && !locked && (
          <button
            type="button"
            onClick={(e) => {
              if (busy && !canSteer && e.altKey) {
                send({ steerNow: true });
              } else {
                send();
              }
            }}
            aria-label={busy && canSteer ? "Send into the running turn" : busy ? "Queue Message (Alt+Click to Steer Now)" : "Send Message"}
            title={busy && canSteer ? "Send into the running turn" : busy ? "Sends when the current turn finishes (Alt+Click to Steer Now)" : "Send"}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full text-white",
              busy && !canSteer ? "bg-raised text-ink-secondary hover:bg-raised-hover" : "bg-accent hover:brightness-110",
            )}
          >
            {busy && !canSteer ? <Clock size={15} /> : <ArrowUp size={17} />}
          </button>
        )}
          </div>
        </div>
      </div>
      </div>
      <div className="pointer-events-auto">
      <LocalComputerAutoWarning
        open={autoWarn}
        onCancel={() => setAutoWarn(false)}
        onConfirm={() => {
          if (autoBot) {
            dispatch({
              type: "updateBot",
              botId: autoBot.id,
              patch: { autoApprove: true, acknowledgeLocalAuto: true },
            });
          }
          setAutoWarn(false);
        }}
      />
      </div>
    </div>
  );
}

// Call mode — the bot on the line.
//
// The loop is deliberately HALF-DUPLEX: the microphone is live only when
// the bot is not speaking. The dictation helper is Apple's SFSpeechRecognizer
// running on raw AVAudioEngine input with no acoustic echo cancellation, so
// a mic left open through playback transcribes the bot's own voice back into
// the conversation and the two of them talk forever. Interrupting is a tap
// or Escape instead, which is honest and cannot feed back. (Full-duplex
// barge-in needs AEC on the capture path — a follow-up, not a footnote.)
//
// Turn-taking uses a small silence endpointer in the native helper. Apple's
// buffer-backed recognizer does not finalize on silence by itself: the helper
// has to end the audio stream, which then produces the final transcript.
//
// The other half of making a call bearable is narration. A bot turn is
// 5-60 seconds of tool calls; silence that long reads as a dropped call. So
// every activity chip the harness narrates (`tool.spoken`) is read aloud as
// it happens, which is why waiting feels like listening to someone work
// rather than listening to nothing.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, Phone, PhoneOff, X } from "lucide-react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { currentCall, deferCallCleanup, endCall, startCall, useOnCall } from "@/lib/call";
import { speaker } from "@/lib/tts";
import { callVoiceReadiness } from "@/lib/tts/readiness";
import { spokenReply } from "../../shared/voice-summary";
import { voiceForDevice } from "../../shared/bot-voice";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { createSTTSession, disposeAppleSTTSession, type STTSession } from "@/lib/call-stt";
import { sessionKeyterms } from "@/lib/stt-keyterms";
import {
  appendStsLine,
  composeCallPersona,
  createEngineTurnWaiter,
  createStsBotEngine,
  createStsCallDriver,
  decideCallMode,
  enginePrompt,
  microphoneAvailable,
  readStsKeys,
  resolveStsApproval,
  spokenApprovalDecision,
  staleApprovalText,
  stsApprovalInstructions,
  stsBridgeAvailable,
  stsCapability,
  stsLineText,
  VOICE_DENIAL_MESSAGE,
  type CallModeDecision,
  type EngineToolRunner,
  type EngineTurnResult,
  type EngineTurnWaiter,
  type StsApprovalCall,
  type StsApprovalView,
  type StsCallDriver,
  type StsLineView,
  type StsProvider,
} from "@/lib/sts/call-session";
// The frozen STS index is the only place `prepareStsSession` lives, and it is
// read-only here — this lane wires the call view, it does not change that layer.
import { prepareStsSession } from "@/lib/sts";
import { useTranscriptionAvailability } from "@/lib/use-transcription-availability";
import { pickSTTProvider, type ProviderChoice } from "@/lib/transcription-provider";
import { BotMascot } from "./Avatar";
import { isRoutineApproval, pendingApprovals, spokenApprovalPrompt, type Pending } from "./PendingApproval";
import { cn } from "@/lib/cn";
import { track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";

/** The card the chat is already rendering, as the permission the engine tool
 *  reasons about.  One request, two views: the model is handed the same words
 *  the chained path would have spoken, so what is on screen and what is said
 *  out loud cannot disagree. */
function toStsApproval(pending: Pending, botName: string): StsApprovalView {
  return {
    requestId: pending.requestId,
    tool: pending.tool,
    routine: isRoutineApproval(pending),
    messageId: pending.message.id,
    prompt: spokenApprovalPrompt(pending, botName),
  };
}

// The anchored yes/no rules that read a spoken answer live in `call-session`
// rather than here: a speech-to-speech call learns what the user said from what
// the model hands back, and both call paths must judge that answer by exactly
// the same standard.

type Phase = "listening" | "sending" | "working" | "speaking";
const CALL_ENDPOINT_MS = 850;

export function CallButton({ bot }: { bot: Bot }) {
  return (
    <CallTargetButton
      targetId={bot.id}
      targetName={bot.name}
      voices={[voiceForDevice(bot, "mac")]}
      setupBotId={bot.id}
      requireExplicitVoices={false}
      onStart={() => track("call_started", { driver: bot.modelSelection?.instanceId })}
    />
  );
}

/**
 * Whether this workspace could run a speech-to-speech call, decided once for
 * the button.
 *
 * `null` means "not known yet", which the button reads as no: a key can only be
 * true after an async bridge read, and rendering the button on the strength of
 * a guess would offer calls this workspace cannot make.  Chained calls are
 * unaffected, so a build without the bridge behaves exactly as it did.
 */
function useStsDecision(preference: StsProvider | null | undefined): CallModeDecision | null {
  const [decision, setDecision] = useState<CallModeDecision | null>(null);
  useEffect(() => {
    let alive = true;
    const bridge = globalThis.window?.ogb;
    if (!stsBridgeAvailable(bridge)) return;
    void (async () => {
      const keys = await readStsKeys(bridge);
      if (!alive) return;
      setDecision(
        decideCallMode({
          capability: stsCapability({
            platform: bridge?.platform ?? "unknown",
            bridgeAvailable: true,
            keys,
            preference,
          }),
          microphoneAvailable: microphoneAvailable(),
        }),
      );
    })();
    return () => {
      alive = false;
    };
  }, [preference]);
  return decision;
}

export function CallTargetButton({
  targetId,
  targetName,
  voices,
  setupBotId,
  requireExplicitVoices,
  onStart,
}: {
  targetId: string;
  targetName: string;
  voices: Array<string | undefined>;
  /** Bot profile to open when voice setup is missing (rooms choose a member). */
  setupBotId?: string;
  /** Rooms cannot rely on one workspace fallback for multiple speakers. */
  requireExplicitVoices: boolean;
  onStart: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const active = useOnCall() === targetId;
  const cloudConfigured = useTranscriptionAvailability();
  const stsDecision = useStsDecision(state.config?.sts?.provider);
  const provider = pickSTTProvider({
    cloudSttConfigured: cloudConfigured,
    appleSpeechAvailable: capabilities.dictation.available && Boolean(window.ogb?.speechStart),
    platform: window.ogb?.platform ?? "unknown",
    explicitPreference: state.config?.callStt?.provider ?? undefined,
  });
  const supported = provider.provider !== null;
  // `configured` is provider-scoped server-side (MiniMax => a key is on file; system => the Mac's
  // built-in voices are available).  It is what a hosted voice needs.
  const configured = Boolean(state.config?.tts?.configured);
  // Apple Personal Voices speak on-device on macOS and iOS companion devices.
  // The main process already gates the flag on the host's macOS version, so a
  // macOS 13 Mac is not offered a call button that can only fail.
  const isPersonalSpeakable = capabilities.dictation.personalVoice === true;
  // One rule for every voice the call would use (src/lib/tts/readiness.ts): a Personal Voice needs
  // the capability flag and never a MiniMax key; a hosted voice needs `configured`.
  const readiness = callVoiceReadiness({
    voices,
    tts: state.config?.tts,
    personalVoiceAvailable: isPersonalSpeakable,
    requireExplicitVoices,
  });
  // Owner 2026-09-03: with no voice provider configured the call button must not appear at all,
  // rather than render disabled with an explanation.  A Personal Voice this Mac can speak is a
  // provider, so a bot that only uses one gets its call button without a MiniMax key.
  // A speech-to-speech provider is one too: it speaks on the call itself, so a workspace with an
  // STS key and no chained TTS setup can still make calls.
  const stsCall = stsDecision?.mode === "sts";
  const voiceProviderConfigured = stsCall || readiness.engineAvailable;
  const hostedEngineMissing = readiness.needsHostedEngine && !configured;
  const personalVoiceChosen = readiness.personalVoiceChosen;
  const voiceReady = readiness.ready && !hostedEngineMissing;
  // An STS call brings its own dictation and its own voice, so the chained gates
  // describe a path this call is not taking.  They still apply in full otherwise.
  const unavailable = !active && (!capabilitiesReady || (!stsCall && (!supported || !voiceReady)));
  const voiceSetupRequired = capabilitiesReady && !stsCall && supported && !voiceReady;
  const [helpOpen, setHelpOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  const label = active
    ? `Hang up on ${targetName}`
    : !capabilitiesReady
      ? "Checking call availability"
      : stsCall
        ? `Call ${targetName}`
      : !supported
        ? "Set up dictation to make calls"
        : hostedEngineMissing
          ? "Set up a voice in a bot profile to make calls"
          : !voiceReady
            ? personalVoiceChosen
              ? capabilities.dictation.reasonCode === "requires-macos-14"
                ? "Personal Voice needs macOS 14 or later, or an iPhone"
                : "Personal Voice needs a Mac or iPhone"
              : "Pick a voice in a bot profile to make calls"
            : `Call ${targetName}`;

  const reason = !capabilitiesReady
    ? "Checking whether this device can make calls."
    : stsCall
      ? ""
      : !supported
        ? provider.provider === null && provider.missing === "cloud-stt-key"
          ? "Add an AssemblyAI API key in Settings to make calls on this computer."
          : "This dictation provider is unavailable.\u00A0 Check your choice in Settings or restart BotFleet."
        : hostedEngineMissing
          ? "Add a MiniMax API key in Settings so the bot can speak during calls."
          : !voiceReady
            ? personalVoiceChosen
              ? capabilities.dictation.reasonCode === "requires-macos-14"
                ? "Apple Personal Voice needs macOS 14 or later, or an iPhone.\u00A0 Pick another voice to make calls on this computer."
                : "Apple Personal Voice speaks on Apple devices (Mac and iPhone).\u00A0 Pick another voice to make calls on this computer."
              : voices.length > 1
                ? "Give every channel member a voice before starting a channel call."
                : "Choose a voice before starting a call."
            : "";

  useEffect(() => {
    if (!helpOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setHelpOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHelpOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [helpOpen]);


  // All hooks above run unconditionally; this guard sits after them so hook order is stable.
  if (!voiceProviderConfigured) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        onClick={() => {
          if (active) return endCall(targetId);
          if (unavailable) {
            setHelpOpen((open) => !open);
            return;
          }
          onStart();
          startCall(targetId);
        }}
        aria-expanded={unavailable ? helpOpen : undefined}
        aria-controls={unavailable ? helpId : undefined}
        aria-label={label}
        title={label}
        className={cn(
          "relative flex size-9 items-center justify-center rounded-full transition-colors",
          active
            ? "bg-danger text-white hover:brightness-110"
            : unavailable
              ? "text-ink-secondary/50 hover:bg-raised hover:text-ink-secondary"
              : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
      >
        {active ? <PhoneOff size={17} /> : <Phone size={17} />}
        {unavailable && (
          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-warning ring-2 ring-app" aria-hidden="true" />
        )}
      </button>

      {unavailable && helpOpen && (
        <div
          id={helpId}
          role="group"
          aria-label="Call Unavailable"
          className="animate-pop-in absolute right-0 z-30 mt-1.5 w-[280px] rounded-xl border border-hairline bg-panel p-3 text-left shadow-2xl"
        >
          <div className="text-[13px] font-medium text-ink">Call Unavailable</div>
          <div className="mt-1 text-[12px] leading-[1.45] text-ink-secondary">{reason}</div>
          {voiceSetupRequired && (
            <button
              type="button"
              onClick={() => {
                setHelpOpen(false);
                if (setupBotId && setupBotId !== targetId) dispatch({ type: "select", id: setupBotId });
                dispatch({ type: "toggleSettings", open: true });
              }}
              className="mt-2.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110"
            >
              Open Bot Settings
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  if (!active) return null;
  return <Call bot={bot} />;
}

function Call({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  // This Mac's voice for the bot: its Mac override, else the shared voice.
  const macVoice = voiceForDevice(bot, "mac");
  const speech = useSpeech();
  const initialPhase: Phase = bot.busy ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const sttSessionRef = useRef<STTSession | null>(null);
  const pushToTalk = usePushToTalk(bot.id, phase === "listening", sttSessionRef, () => {
    setNote(sttSessionRef.current?.provider === "assemblyai"
      ? "Cloud dictation couldn't start.\u00A0 Check the AssemblyAI key, connection, and microphone access."
      : "Push to talk couldn't start.\u00A0 Check Microphone and Speech Recognition access.");
  });

  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];
  const question = messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );

  // Everything already on screen when the call starts has been read or
  // ignored — a call must not open by reciting the backlog.
  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const m of messages) spokenIds.current.add(m.id);
  }

  // the approval we last asked about aloud, so a card that stays open
  // while the user thinks is not re-read every render
  const askedApproval = useRef<{ requestId: string; routine: boolean; submitted: boolean } | null>(null);
  const askedQuestion = useRef<{ requestId: string; messageId: string } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);
  // ── speech-to-speech state ─────────────────────────────────────────────
  // The mode is decided once, on mount, and never changes mid-call.  It lives in
  // a ref as well as state because the chained callbacks below must not reopen a
  // dictation session on an STS call, and a ref keeps them from being rebuilt
  // (and the microphone effect from being torn down) every time it resolves.
  const [callMode, setCallMode] = useState<CallModeDecision | null>(null);
  const stsModeRef = useRef(false);
  const [stsLines, setStsLines] = useState<StsLineView[]>([]);
  const stsLineKey = useRef(0);
  const stsDriverRef = useRef<StsCallDriver | null>(null);
  const engineWaiterRef = useRef<EngineTurnWaiter | null>(null);
  if (!engineWaiterRef.current) engineWaiterRef.current = createEngineTurnWaiter();
  // The engine tool runs a real bot turn, so it needs the live conversation to
  // tell a new reply from one that was already on screen.
  const botRef = useRef(bot);
  botRef.current = bot;
  // The permissions this call is holding, and the ones it has already answered.
  // Both are refs because the engine tool runs from a provider callback rather
  // than from a render, and a tool call must never close over a stale list.
  const approvalsRef = useRef<StsApprovalView[]>([]);
  approvalsRef.current = pendingApprovals(messages).map((pending) => toStsApproval(pending, bot.name));
  const decidedRef = useRef<Set<string>>(new Set());
  // The STT provider session is chosen once per call and reused across every
  // listen cycle. The provider picker decides apple (macOS, no cloud key) vs
  // assemblyai (cross-platform, or macOS-with-key per the picker default).


  /** Change the rendered phase and the synchronous phase used by native
   * callbacks together. React state alone is too late: the helper can exit
   * in the same tick as a final transcript or an intentional mute. */
  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void sttSessionRef.current?.stop();
  }, []);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    // An STS call has no dictation session to open: the provider holds the
    // microphone for the whole conversation.  Reaching here would start a second
    // capture on top of it.
    if (stsModeRef.current) return;
    move("listening");
    setHeard("");
    setNote(null);
    if (!sttSessionRef.current) return;
    const session = sttSessionRef.current;
    session.start({ endpointMs: CALL_ENDPOINT_MS, keyterms: sessionKeyterms([bot.name], state.config?.callStt?.keyterms ?? []) }).catch(() => {
      if (alive.current && currentCall() === bot.id) {
        setNote(session?.provider === "assemblyai"
          ? "Cloud dictation couldn't start.\u00A0 Check the AssemblyAI key, connection, and microphone access."
          : "The microphone couldn't start.\u00A0 Check Microphone and Speech Recognition access.");
      }
    });
  }, [bot.id, bot.name, move, state.config?.callStt?.keyterms]);

  /** Speak, with the microphone closed for the duration (see the header
   * comment — an open mic during playback is a feedback loop). */
  const say = useCallback(
    async (text: string, messageId?: string) => {
      if (!alive.current || currentCall() !== bot.id) return false;
      const mine = ++sayGeneration.current;
      // Move first. stopSpeech() finishes asynchronously, and its close must
      // never observe an old "listening" phase and reopen the mic.
      move("speaking");
      hush();
      // A bot reply goes through the server's message audio route so the voice
      // summary mode and clip cache apply; other prompts are spoken as written.
      await speaker.speak(text, { botId: bot.id, voiceId: macVoice, ...(messageId ? { messageId, threadId: bot.threadId } : {}) });
      return alive.current && currentCall() === bot.id && sayGeneration.current === mine;
    },
    [bot.id, macVoice, bot.threadId, hush, move],
  );

  const sayThenListen = useCallback(
    async (text: string, messageId?: string) => {
      const stillMine = await say(text, messageId);
      if (stillMine && phaseRef.current === "speaking") listen();
    },
    [listen, say],
  );

  /** Turn one settled engine turn into the text the model reads.  A turn that
   * stopped for permission becomes the sentence to ask out loud, so the model
   * hears the request while the turn it already dispatched is still waiting. */
  const engineTurnText = useCallback((result: EngineTurnResult): string => {
    if (result.kind !== "approval") return result.text;
    const outcome = resolveStsApproval(
      { action: "ask", requestId: result.requestId },
      approvalsRef.current,
      decidedRef.current,
    );
    return outcome.kind === "ask" ? outcome.text : staleApprovalText();
  }, []);

  /**
   * Answer a permission the model asked about.
   *
   * The user's speech reaches the model on this call, never the app, so the
   * answer arrives as text the model hands back and the app reads it.  The
   * decision then goes out through `decideRequest` — the same action the
   * permission card's own buttons dispatch — so a spoken "yes" and a clicked
   * "Allow Once" are one decision with one record.  The card is never told to
   * disappear: it settles the way it settles for a click.
   */
  const runVoiceApproval = useCallback(
    async (request: StsApprovalCall, signal: AbortSignal): Promise<string> => {
      const outcome = resolveStsApproval(request, approvalsRef.current, decidedRef.current);
      // Anything but a decision — including an answer that could not be read
      // unambiguously — goes back to the model as text, having submitted
      // nothing.
      if (outcome.kind !== "decided") return outcome.text;

      const { requestId, decision } = outcome;
      const waiter = engineWaiterRef.current;
      // Claimed before the request goes out, exactly as the chained path does:
      // until the server's durable card patch lands this request is still on
      // screen and must not be answered a second time.
      decidedRef.current.add(requestId);
      dispatch({
        type: "decideRequest",
        threadId: bot.threadId,
        requestId,
        behavior: decision,
        message: decision === "deny" ? VOICE_DENIAL_MESSAGE : undefined,
        onError: (error: string) => {
          // A decision the server refused is no decision at all: hand the claim
          // back so the request can be answered again, and say so rather than
          // leaving the model to wait out the deadline in silence.
          decidedRef.current.delete(requestId);
          const detail = error.trim().slice(0, 240);
          waiter?.note(
            `That approval could not be saved${detail ? `: ${detail}` : "."}  Ask the caller to answer it again.`,
          );
        },
      });
      // Armed after the dispatch, so the card's own settle patch counts as
      // already on screen and only the engine's reply can satisfy this wait.
      const before = new Set(visibleMessages(botRef.current).map((message) => message.id));
      const answer = waiter?.arm(before, signal);
      if (!answer) throw new Error("The bot's engine is not available on this call.");
      // The engine was mid-turn and is running again: this waits for what it
      // has to say about the decision, under the same deadline as any turn.
      return engineTurnText(await answer);
    },
    [bot.threadId, dispatch, engineTurnText],
  );

  /**
   * The bot's own engine, as the `bot_engine` function tool.
   *
   * This is the same turn the chained path runs when it dispatches a send: the
   * voice model decides to call the tool, the call dispatches a real turn, and
   * the reply that lands resolves the tool.  Nothing here waits on a rendering
   * effect or a second HTTP endpoint.  The same tool also carries a permission
   * the user has to answer, because on this call there is no other way to ask.
   *
   * The deadline is the provider's, not this function's: it aborts `signal`, the
   * waiter rejects, `callBotEngine` records a bypass, and the model answers that
   * turn itself with the transcript marked.
   */
  const runEngineTool = useCallback<EngineToolRunner>(
    async (call, signal) => {
      if (call.approval) return runVoiceApproval(call.approval, signal);
      const before = new Set(visibleMessages(botRef.current).map((message) => message.id));
      const answer = engineWaiterRef.current?.arm(before, signal);
      dispatch({ type: "send", botId: bot.id, text: enginePrompt(call) });
      if (!answer) throw new Error("The bot's engine is not available on this call.");
      return engineTurnText(await answer);
    },
    [bot.id, dispatch, engineTurnText, runVoiceApproval],
  );

  // Navigating away from this bot hangs up. Without ownership checking, the
  // overlay disappeared but `currentCall()` remained set and auto-speak was
  // permanently disabled for a call nobody could see.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sayGeneration.current += 1;
      // StrictMode immediately remounts effects once in development. A
      // microtask distinguishes that probe from real navigation: the probe
      // has set alive=true again before this runs; a genuine unmount has not.
      deferCallCleanup(bot.id, () => alive.current);
    };
  }, [bot.id]);

  // ── the microphone ───────────────────────────────────────────────────
  useEffect(() => {
    let detached = false;
    let offTranscript: () => void = () => {};
    let offEnd: () => void = () => {};
    let session: STTSession | null = null;

    const handleTranscript = (line: { text: string; partial: boolean; error?: string }) => {
      if (!alive.current || currentCall() !== bot.id || phaseRef.current !== "listening") return;
      if (speaker.state.status === "speaking" || speaker.state.status === "preparing") return;
      if (line.error) {
        setNote(sttSessionRef.current?.provider === "assemblyai"
          ? "Cloud dictation stopped unexpectedly.\u00A0 Check the AssemblyAI key, connection, and microphone access."
          : "Dictation stopped unexpectedly.\u00A0 Check Microphone and Speech Recognition access.");
        return;
      }
      if (typeof line.text !== "string") return;
      setHeard(line.text);
      if (line.partial !== false) return;
      // final result — the recognizer decided the turn ended
      const said = line.text.trim();
      if (!said) return listen();

      // Acoustic echo suppression: drop text heard from speaker output
      const recentBotTexts = messages
        .filter((m) => m.role === "bot" && m.text)
        .slice(-5)
        .map((m) => m.text!.toLowerCase().replace(/[^a-z0-9]/g, " ").trim());
      const normalized = said.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
      if (
        normalized.length > 8 &&
        recentBotTexts.some(
          (botText) =>
            botText.includes(normalized) ||
            (normalized.length > 20 && botText.split(" ").filter((w) => w.length > 3 && normalized.includes(w)).length >= 3),
        )
      ) {
        return listen();
      }

      const open = askedApproval.current;
      if (open) {
        if (open.submitted) {
          move("working");
          hush();
          return;
        }
        const spoken = spokenApprovalDecision(said);
        if (spoken !== "unclear") {
          const allow = spoken === "allow";
          // Keep this request claimed until the server's durable card patch
          // arrives. Clearing it here lets a render in that network gap read
          // and submit the same approval again.
          open.submitted = true;
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: bot.threadId,
            requestId: open.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : VOICE_DENIAL_MESSAGE,
            onError: (error: string) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== bot.id ||
                pending?.requestId !== open.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              const detail = error.trim().slice(0, 240);
              const decision = open.routine ? "routine decision" : "approval";
              void sayThenListen(
                `I couldn't save that ${decision}${detail ? `: ${detail}` : "."} Please try again.`,
              );
            },
          });
          return;
        }
        // not a decision — leave the card up and say so rather than
        // guessing consent from an ambiguous sentence
        void sayThenListen("Sorry — is that a yes or a no?");
        return;
      }

      const openQuestion = askedQuestion.current;
      if (openQuestion) {
        askedQuestion.current = null;
        dispatch({ type: "answerCard", botId: bot.id, messageId: openQuestion.messageId, answer: said });
        move("working");
        hush();
        return;
      }

      move("sending");
      dispatch({ type: "send", botId: bot.id, text: said });
    };

    const handleEnd = ({ code, reason }: { code: number; reason?: string }) => {
      if (!alive.current || currentCall() !== bot.id) return;
      if (code === 2) {
        setNote("Calls need a working dictation provider.\u00A0 Add an AssemblyAI key in Settings, or install the desktop app for macOS.");
        return;
      }
      if (code === 1) {
        setNote(
          session?.provider === "assemblyai"
            ? "Cloud dictation stopped.\u00A0 Check the AssemblyAI key, connection, and microphone access."
            : reason === "helper-build-failed"
              ? "The dictation helper couldn't be built.\u00A0 Install Apple's Command Line Tools and try again."
              : "Dictation needs Microphone + Speech Recognition access in System Settings.",
        );
        return;
      }
      // The helper exits after every final result; if we are still meant
      // to be listening, that means the user's turn ended — start the next.
      if (phaseRef.current === "listening" && alive.current) listen();
    };

    (async () => {
      const bridge = window.ogb;
      if (!bridge || detached) return;

      // ── which mode this call runs in ───────────────────────────────────
      // Asked before the dictation probe so an STS call never waits on one.
      // Every failure here — no bridge, no key, no microphone — falls through
      // to the chained path below exactly as before, silently: a call that
      // quietly keeps working beats a call that refuses.
      const decision = decideCallMode({
        capability: stsCapability({
          platform: bridge.platform ?? "unknown",
          bridgeAvailable: stsBridgeAvailable(bridge),
          keys: await readStsKeys(bridge),
          preference: state.config?.sts?.provider ?? null,
        }),
        microphoneAvailable: microphoneAvailable(),
      });
      if (detached || !alive.current) return;
      setCallMode(decision);

      if (decision.mode === "sts" && decision.provider) {
        const provider = decision.provider;
        // Latched before the first await: the chained callbacks below read this
        // synchronously, and React can render between any two awaits.
        stsModeRef.current = true;
        const frontEngine = state.config?.sts?.frontEngine !== false;
        // Built even when the front engine is off, so the preference stays one
        // setting read; prepareStsSession decides whether it is offered.
        const botEngine = createStsBotEngine(runEngineTool);
        const prepared = prepareStsSession(provider, {
          persona: composeCallPersona(bot),
          engineTimeoutMs: state.config?.sts?.engineTimeoutMs,
          frontEngine,
          botEngine,
        });
        // The approval clause rides last, so the model reads the rule after it
        // has met the tool the rule is about.  It is only added when the tool
        // is actually offered: told about a tool it does not have, a model
        // would invent calls that cannot succeed.
        const instructions = frontEngine
          ? `${prepared.instructions}\n\n${stsApprovalInstructions()}`
          : prepared.instructions;
        const engine = frontEngine ? botEngine : undefined;
        const driver = createStsCallDriver(prepared.session, {
          onLine: (line) => {
            if (!alive.current || currentCall() !== bot.id) return;
            setStsLines((current) => appendStsLine(current, line, stsLineKey.current++));
          },
          onError: (error) => {
            if (!alive.current || currentCall() !== bot.id) return;
            // Release the microphone but keep the call on screen, so the note
            // is read rather than swallowed by a silent teardown.  A
            // speech-to-speech session cannot be resumed by reopening a mic,
            // so the only honest action left is to end the call.
            void driver.stop().catch(() => {});
            engineWaiterRef.current?.cancel();
            setNote(`The voice connection dropped.\u00A0 ${error.message}`);
          },
          onClosed: (reason) => {
            if (!alive.current || currentCall() !== bot.id) return;
            // A vendor goAway or an expiry leaves nothing to talk to.  The call
            // does not hang: the microphone is released, the status says the
            // connection is gone, and the reason is on screen.  Ending the call
            // silently instead would read as the app hanging up on the user.
            void driver.stop().catch(() => {});
            engineWaiterRef.current?.cancel();
            setNote(`The voice connection ended.\u00A0 ${reason}`);
          },
        });
        stsDriverRef.current = driver;
        try {
          // Listeners and the microphone attach first; the providers drop audio
          // until their handshake lands, so nothing said in between is lost.
          await driver.start();
          await prepared.session.start({
            instructions,
            botEngine: engine,
            engineTimeoutMs: prepared.timeoutMs,
          });
        } catch (error) {
          if (alive.current && currentCall() === bot.id) {
            setNote(error instanceof Error ? error.message : String(error));
            endCall(bot.id);
          }
          return;
        }
        // The provider runs its own turn loop, so the phase machine stays on
        // "listening": the bot is always reachable and never hands the mic back.
        move("listening");
        return;
      }

      const status = await bridge.transcription?.status?.().catch(() => undefined);
      const cloudSttConfigured = Boolean(status?.configured);
      const platform = bridge.platform ?? "unknown";
      const choice: ProviderChoice = pickSTTProvider({
        cloudSttConfigured,
        appleSpeechAvailable: capabilities.dictation.available,
        platform,
        explicitPreference: state.config?.callStt?.provider ?? undefined,
      });
      if (choice.provider === null) {
        if (alive.current && currentCall() === bot.id) {
          setNote(
            choice.missing === "cloud-stt-key"
              ? "Add an AssemblyAI API key in Settings to use voice on this computer."
              : "Dictation isn't available in this app build.\u00A0 Restart or update BotFleet.",
          );
        }
        return;
      }
      if (detached || !alive.current) return;
      const created = createSTTSession(choice.provider);
      sttSessionRef.current = created;
      session = created;
      offTranscript = created.onTranscript(handleTranscript);
      offEnd = created.onEnd(handleEnd);
      if (bot.busy && !approval && !question) move("working");
      else listen();
    })().catch((error) => {
      if (alive.current && currentCall() === bot.id) {
        setNote(error instanceof Error ? error.message : String(error));
      }
    });

    return () => {
      detached = true;
      offTranscript();
      offEnd();
      if (session?.provider === "apple") disposeAppleSTTSession(session);
      void session?.stop().catch(() => {});
      if (sttSessionRef.current === session) sttSessionRef.current = null;
      // The STS driver is stopped on hangup and on unmount alike, and its own
      // stop is idempotent, so the two paths cannot tear the session twice.
      void stsDriverRef.current?.stop().catch(() => {});
      if (stsDriverRef.current) stsDriverRef.current = null;
      engineWaiterRef.current?.cancel();
    };
    // busy/approval are intentionally initial snapshots. Their live changes
    // are handled below without tearing down native event listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.threadId, dispatch, hush, listen, move, runEngineTool, sayThenListen]);

  // ── the engine's reply, when the model called the tool ────────────────
  useEffect(() => {
    // A no-op unless a turn is armed, which only ever happens on an STS call.
    engineWaiterRef.current?.observe(messages);
  }, [messages]);

  // ── narrate the work, speak the answer, read the approvals ───────────
  useEffect(() => {
    // An STS call speaks for itself: the provider owns both the voice and the
    // turn loop.  Reading replies aloud here would talk over the model, and
    // asking about approval cards aloud would need the dictation this call
    // deliberately does not open.
    if (stsModeRef.current) {
      for (const m of messages) spokenIds.current.add(m.id);
      return;
    }
    // The request may be resolved from the normal approval UI or by another
    // client while this call is open. Do not keep treating future speech as
    // an answer to a card that no longer exists.
    let resumeAfterRoutine = false;
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }
    if (!approval && !question && bot.busy && phaseRef.current === "listening") {
      move("working");
      hush();
    }
    if (resumeAfterRoutine && !approval && !question && !bot.busy) {
      listen();
      return;
    }
    // Nothing may reopen capture or narrate new work while the server is
    // durably settling this exact decision.
    if (askedApproval.current?.submitted) return;
    if (approval && askedApproval.current?.requestId !== approval.requestId && phase !== "speaking") {
      askedApproval.current = {
        requestId: approval.requestId,
        routine: isRoutineApproval(approval),
        submitted: false,
      };
      spokenIds.current.add(approval.message.id);
      void sayThenListen(spokenApprovalPrompt(approval, bot.name));
      return;
    }
    if (
      question?.card?.requestId &&
      askedQuestion.current?.requestId !== question.card.requestId &&
      phase !== "speaking"
    ) {
      askedQuestion.current = { requestId: question.card.requestId, messageId: question.id };
      spokenIds.current.add(question.id);
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? ` The options are ${question.card.options.join(", ")}.`
        : "";
      void sayThenListen(`${bot.name} asks: ${detail}${/[.!?]$/.test(detail) ? "" : "."}${choices}`);
      return;
    }
    const fresh = messages.filter((m) => !spokenIds.current.has(m.id));
    if (!fresh.length) return;
    // only the newest of each kind matters: a burst of tool chips should
    // not queue thirty seconds of narration behind the actual answer
    const reply = [...fresh].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
    const chip = [...fresh].reverse().find((m) => m.kind === "activity" && m.tool?.spoken);
    for (const m of fresh) spokenIds.current.add(m.id);

    if (reply?.text) {
      void sayThenListen(spokenReply(reply.text), reply.id);
    } else if (chip?.tool?.spoken && phase === "working") {
      void say(chip.tool.spoken).then((stillMine) => {
        if (stillMine && phaseRef.current === "speaking") move("working");
      });
    }
  }, [messages, approval, question, phase, bot.busy, bot.name, hush, listen, move, say, sayThenListen]);

  // busy is the harness's word for "a turn is running"
  useEffect(() => {
    // An STS call runs turns of its own, and this bot going busy means the
    // engine tool is working — not that the microphone should close.
    if (stsModeRef.current) return;
    if (bot.busy) {
      // An open approval deliberately keeps the mic live for yes/no. Every
      // other busy phase is half-duplex and must close capture.
      if (phaseRef.current !== "speaking" && !askedApproval.current && !askedQuestion.current) {
        move("working");
        hush();
      }
    } else if (
      phaseRef.current === "working" &&
      !askedApproval.current &&
      !askedQuestion.current &&
      !speaker.isSpeaking()
    ) {
      // A failed/cancelled turn may have no reply to trigger the normal
      // speak-then-listen path. Recover the call instead of staying stuck.
      listen();
    }
  }, [bot.busy, hush, listen, move]);

  // Escape hangs up; space interrupts whatever is being said
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        endCall(bot.id);
      } else if (e.code === "Space" && speaker.isSpeaking()) {
        e.preventDefault();
        sayGeneration.current += 1;
        speaker.stop();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bot.id, listen]);

  const mascotState =
    phase === "listening" ? "listening" : phase === "speaking" ? "sending" : phase === "sending" ? "thinking" : "working";
  // A speech-to-speech call that has lost its session must not keep claiming
  // it is listening to someone.
  const stsBroken = callMode?.mode === "sts" && Boolean(note);
  const status = stsBroken
    ? "Not connected"
    : phase === "listening"
      ? pushToTalk
        ? "Push to talk"
        : "Listening"
      : phase === "sending"
        ? "One moment"
        : phase === "speaking"
          ? bot.name
          : "Working";

  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">
      <button
        onClick={() => endCall(bot.id)}
        aria-label="Hang Up"
        className="absolute right-5 top-5 rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <X size={18} />
      </button>

      <BotMascot color={bot.color} state={mascotState} size={220} animated trackPointer />

      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-ink">{bot.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">
          {(phase === "working" || phase === "sending") && <Loader2 size={13} className="animate-spin" />}
          {status}
        </div>
      </div>

      {/* one line, whichever is current: what you're saying, or what it is */}
      <div className="min-h-[3.5rem] max-w-[560px] px-6 text-center text-[15px] leading-relaxed text-ink">
        {callMode?.mode === "sts" ? (
          stsLines.length ? (
            <div className="flex flex-col items-center gap-1.5 text-left">
              {stsLines.slice(-6).map((line) => (
                <div
                  key={line.key}
                  className={cn(
                    "w-full text-[14px]",
                    line.from === "user" ? "text-ink-secondary" : "text-ink",
                    // A turn the bot answered alone is marked, so the user can
                    // tell it from the bot's own answer.
                    line.engineBypassed && "text-warning",
                    !line.final && "opacity-70",
                  )}
                >
                  {stsLineText(line)}
                </div>
              ))}
            </div>
          ) : (
            <span className="text-ink-secondary">Say something…</span>
          )
        ) : phase === "listening" ? (
          heard || (
            <span className="text-ink-secondary">
              {pushToTalk ? "Release Control + Option to send…" : "Say something…"}
            </span>
          )
        ) : (
          speech.caption
        )}
      </div>

      {note && (
        <div className="flex max-w-[460px] flex-col items-center gap-2 text-center text-[12.5px] text-warning">
          <span>{note}</span>
          {callMode?.mode === "sts" ? (
            // A speech-to-speech session cannot be resumed by reopening a
            // microphone; the session is gone.  Ending the call is the only
            // honest action left to offer.
            <button
              onClick={() => endCall(bot.id)}
              className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10"
            >
              End Call
            </button>
          ) : (
            <button
              onClick={listen}
              className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10"
            >
              Try microphone again
            </button>
          )}
        </div>
      )}
      {speech.error && <div className="max-w-[420px] text-center text-[12.5px] text-danger">{speech.error}</div>}

      <div className="flex items-center gap-3">
        {speaker.isSpeaking() && (
          <button
            onClick={() => {
              sayGeneration.current += 1;
              speaker.stop();
              listen();
            }}
            className="rounded-full border border-hairline/50 px-4 py-2 text-[13.5px] text-ink hover:bg-raised"
          >
            Interrupt
          </button>
        )}
        <button
          onClick={() => endCall(bot.id)}
          className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          <PhoneOff size={16} /> Hang Up
        </button>
      </div>

      <div className="text-[11.5px] text-ink-secondary/70">
        {callMode?.mode === "sts"
          ? // The provider truncates its own playback when the caller speaks
            // over the bot, so the chained Space interrupt would be a lie here.
            "Talk over the bot to interrupt · Esc hangs up"
          : `${sttSessionRef.current?.provider === "apple" ? "Hold Control + Option to talk · " : ""}Space interrupts · Esc hangs up`}
      </div>
    </div>
  );
}

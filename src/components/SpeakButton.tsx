import { Loader2, Play, Square } from "lucide-react";

import { speaker } from "@/lib/tts";
import { speakButtonState } from "@/lib/tts/readiness";
import { useSpeech } from "@/lib/tts/useSpeech";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { useDesktopCapabilities } from "./DesktopCapabilities";

/** Read one message aloud or replay existing audio. Hover-revealed beside the copy control, and it
 * becomes a stop button while this message is the one speaking — the same
 * button, because "play" and "stop" are the same intent twice.
 *
 * The voice is this Mac's: the bot's Mac override, else its shared voice.
 * A hosted voice needs a voice engine key; an Apple Personal Voice speaks
 * on this Mac and needs only the Personal Voice capability.  Without what it
 * needs the button stays visible on hover but disabled, saying what it needs.
 * The rules are speakButtonState (src/lib/tts/readiness.ts). */
export function SpeakButton({
  text,
  botId,
  messageId,
  threadId,
  hasAudio,
  voiceId,
  className,
}: {
  text: string;
  botId?: string;
  messageId: string;
  threadId: string;
  hasAudio?: boolean;
  /** The bot's voice as the caller knows it.  The store's copy of the bot,
   * resolved for this Mac, wins when the bot is known. */
  voiceId?: string;
  className?: string;
}) {
  const { state } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const speech = useSpeech();
  const { macVoice, ready, mine, preparing, failed, label } = speakButtonState({
    owner: botId ? state.bots?.find((bot) => bot.id === botId) : undefined,
    voiceId,
    tts: state.config?.tts,
    personalVoiceAvailable: capabilities.dictation.personalVoice === true,
    hasAudio,
    messageId,
    speech,
  });
  return (
    <button
      onClick={() => {
        if (mine) return speaker.stop();
        void speaker.speak(text, { botId, messageId, threadId, voiceId: macVoice });
      }}
      disabled={!ready}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary",
        // stays visible while speaking, after a failure, or when audio is already synthesized
        mine || hasAudio ? "text-accent opacity-100" : failed ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        // the last attempt failed: the title says why
        failed && !mine && "text-danger hover:text-danger",
        className,
      )}
    >
      {preparing ? <Loader2 size={16} className="animate-spin" /> : mine ? <Square size={16} className="fill-current" /> : <Play size={16} className="fill-current" />}
    </button>
  );
}

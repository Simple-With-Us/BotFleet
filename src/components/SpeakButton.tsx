import { Loader2, Play, Square } from "lucide-react";

import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";

/** Read one message aloud or replay existing audio. Hover-revealed beside the copy control, and it
 * becomes a stop button while this message is the one speaking — the same
 * button, because "play" and "stop" are the same intent twice.
 *
 * Without a key it stays visible on hover but disabled, saying what it needs. */
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
  voiceId?: string;
  className?: string;
}) {
  const { state } = useStore();
  const speech = useSpeech();
  const tts = state.config?.tts;
  const configured = Boolean(tts?.configured);
  const ready = hasAudio || (configured && Boolean(voiceId || tts?.voice));
  const mine = speech.messageId === messageId && speech.status !== "idle";
  const preparing = mine && speech.status === "preparing";

  const label = hasAudio
    ? (mine ? "Stop Audio" : "Play Audio")
    : !configured
      ? "Add a voice engine key in settings to play audio"
      : !ready
        ? "Pick a voice in settings to play audio"
        : mine
          ? "Stop Speaking"
          : "Play (Speak Aloud)";
  return (
    <button
      onClick={() => {
        if (mine) return speaker.stop();
        void speaker.speak(text, { botId, messageId, threadId, voiceId });
      }}
      disabled={!ready}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-focus-within:opacity-100 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary",
        // stays visible while speaking or when audio is already synthesized
        mine || hasAudio ? "text-accent opacity-100" : "opacity-0 group-hover:opacity-100",
        className,
      )}
    >
      {preparing ? <Loader2 size={16} className="animate-spin" /> : mine ? <Square size={16} className="fill-current" /> : <Play size={16} className="fill-current" />}
    </button>
  );
}

import { Loader2, Square, Volume2 } from "lucide-react";

import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";

/** Read one message aloud. Hover-revealed beside the copy control, and it
 * becomes a stop button while this message is the one speaking — the same
 * button, because "speak" and "shut up" are the same intent twice.
 *
 * Without a key it stays visible but disabled, saying what it needs: a
 * hidden button is a feature nobody discovers. */
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

  const label = hasAudio ? (mine ? "Stop Speaking" : "Replay Voice") : !configured
    ? "Add a voice engine key in a bot profile to read messages aloud"
    : !ready
      ? "Pick a voice in this bot's profile to read messages aloud"
    : mine
      ? "Stop Speaking"
      : "Read This Aloud";
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
        // stays visible while speaking — a stop button you have to hunt for
        // is not a stop button
        mine || hasAudio ? "text-accent opacity-100" : "opacity-0 group-hover:opacity-100",
        className,
      )}
    >
      {preparing ? <Loader2 size={14} className="animate-spin" /> : mine ? <Square size={14} className="fill-current" /> : <Volume2 size={14} />}
    </button>
  );
}

import { useSyncExternalStore } from "react";

import { speakingBotId, speaker, type SpeechSnapshot } from "./index";

/** Live speaker state. useSyncExternalStore rather than a context: the
 * speaker is a window-wide singleton with no provider to hang off, and only
 * the components that actually render voice UI should re-render when an
 * utterance changes. */
export function useSpeech(): SpeechSnapshot {
  return useSyncExternalStore(
    (fn) => speaker.subscribe(fn),
    () => speaker.state,
    () => speaker.state,
  );
}

/**
 * The bot whose voice is playing, or undefined.
 *
 * A narrower subscription than useSpeech, for the components that only need
 * to know whether their own bot is the one talking.  The snapshot carries the
 * caption and the spoken text, and it is replaced on every utterance, so a
 * subscriber to all of it re-renders on every line of a reply.  This returns
 * one string, and a string that has not changed does not re-render anything.
 */
export function useSpeakingBotId(): string | undefined {
  return useSyncExternalStore(
    (fn) => speaker.subscribe(fn),
    () => speakingBotId(speaker.state),
    () => undefined,
  );
}

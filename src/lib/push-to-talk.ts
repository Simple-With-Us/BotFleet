import { useEffect, useRef, useState } from "react";

import { currentCall } from "./call";
import type { STTSession } from "./call-stt";

type ModifierEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "code" | "repeat">;

export function isPushToTalkPress(event: ModifierEvent): boolean {
  const modifier =
    event.code === "AltLeft" ||
    event.code === "AltRight" ||
    event.code === "ControlLeft" ||
    event.code === "ControlRight";
  return modifier && event.altKey && event.ctrlKey && !event.repeat;
}

/** Hold Control + Option to replace automatic endpointing with a manually
 * finalized utterance. The ordinary call listener remains the default. */
export function usePushToTalk(
  targetId: string,
  enabled: boolean,
  sessionRef: { current: STTSession | null },
  onError: () => void,
): boolean {
  const [active, setActive] = useState(false);
  const held = useRef(false);
  const starting = useRef<Promise<void> | null>(null);
  const heldSession = useRef<STTSession | null>(null);
  const generation = useRef(0);
  const enabledRef = useRef(enabled);
  const onErrorRef = useRef(onError);
  enabledRef.current = enabled;
  onErrorRef.current = onError;

  useEffect(() => {
    if (enabled) return;
    held.current = false;
    heldSession.current = null;
    generation.current += 1;
    setActive(false);
  }, [enabled]);

  useEffect(() => {
    const finish = () => {
      if (!held.current) return;
      held.current = false;
      setActive(false);
      const session = heldSession.current;
      heldSession.current = null;
      if (!session || sessionRef.current !== session) return;
      // A quick key release can precede Apple's stop/start transition.
      // Never finalize the previous recognition cycle by racing start.
      const current = generation.current;
      void (starting.current ?? Promise.resolve()).then(() => {
        if (generation.current === current && sessionRef.current === session) return session.finish();
      }).catch(() => onErrorRef.current());
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        held.current ||
        !enabledRef.current ||
        currentCall() !== targetId ||
        !isPushToTalkPress(event)
      ) {
        return;
      }
      const session = sessionRef.current;
      if (!session) return;
      event.preventDefault();
      held.current = true;
      heldSession.current = session;
      generation.current += 1;
      setActive(true);
      // Apple needs a fresh un-endpointed recognition cycle. Cloud is
      // already capturing; restarting it here would open a second mic.
      if (session.provider === "apple") {
        const cycle = session.stop().then(() => session.start({ endpointMs: 0 }));
        starting.current = cycle;
        void cycle.catch(() => {
          held.current = false;
          setActive(false);
          onErrorRef.current();
        }).finally(() => {
          if (starting.current === cycle) starting.current = null;
        });
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!held.current || (event.altKey && event.ctrlKey)) return;
      event.preventDefault();
      finish();
    };
    const onBlur = () => finish();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      held.current = false;
      heldSession.current = null;
      generation.current += 1;
    };
  }, [targetId, sessionRef]);

  return active;
}

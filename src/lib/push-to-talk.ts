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

/** Hold Control + Option for a manually finalized Apple utterance.
 * AssemblyAI's server-side endpoint is fixed for the socket lifetime; do
 * not advertise a manual hold while its ordinary 850 ms endpoint is active. */
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
      if (!session || session.provider !== "apple") return;
      event.preventDefault();
      held.current = true;
      heldSession.current = session;
      generation.current += 1;
      setActive(true);
      // Apple needs a fresh no-endpoint recognition cycle for this hold.
      const current = generation.current;
      const cycle = session.stop().then(() => {
        if (held.current && generation.current === current && sessionRef.current === session) {
          return session.start({ endpointMs: 0 });
        }
      });
      starting.current = cycle;
      void cycle.catch(() => {
        if (generation.current !== current) return;
        held.current = false;
        heldSession.current = null;
        setActive(false);
        onErrorRef.current();
      }).finally(() => {
        if (starting.current === cycle) starting.current = null;
      });
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

import { useEffect, useState } from "react";

import { TRANSCRIPTION_STATUS_EVENT } from "./transcription-status";

/** A live credential signal for surfaces that can offer cloud dictation. */
export function useTranscriptionAvailability(): boolean {
  const [configured, setConfigured] = useState(false);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const update = (event: CustomEvent<{ configured: boolean }>) => {
      revision += 1;
      setConfigured(event.detail.configured);
    };
    const initialRevision = revision;
    window.addEventListener(TRANSCRIPTION_STATUS_EVENT, update);
    void window.ogb?.transcription?.status?.().then((status) => {
      if (active && revision === initialRevision) setConfigured(Boolean(status?.configured));
    }).catch(() => {});
    return () => {
      active = false;
      window.removeEventListener(TRANSCRIPTION_STATUS_EVENT, update);
    };
  }, []);
  return configured;
}

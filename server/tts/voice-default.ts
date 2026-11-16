// The workspace default voice, and the gate that decides whether a cloned
// voice may hold it.
//
// It lives on its own because two modules need it and one of them is
// imported by the other:  the voice settings module owns the description the
// settings panel reads, and the provider ladder owns the synthesis.

import type { AppConfig } from "../config.ts";
import { isClonedVoiceId } from "./minimax.ts";

/** Whether the workspace lets a cloned voice be the workspace default.
 *
 *  The switch is off unless it is explicitly on, so a clone never takes the
 *  default slot by accident. */
export function clonedVoiceAllowed(cfg: AppConfig): boolean {
  return cfg.tts?.useClonedVoice === true;
}

/** The workspace default voice, when the workspace's switch allows it.
 *
 *  A clone that was the default before the switch existed, or before the
 *  switch was turned off, must not keep speaking for every bot that has no
 *  voice of its own:  the switch has to mean off. */
export function defaultVoice(cfg: AppConfig): string {
  const voice = cfg.tts?.voice ?? "";
  if (!voice) return "";
  if (!clonedVoiceAllowed(cfg) && isClonedVoiceId(voice)) return "";
  return voice;
}

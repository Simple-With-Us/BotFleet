// Shared TTS types used across minimax.ts and system-voices.ts.
export interface Voice {
  id: string;
  label: string;
  description?: string;
  /** True for a voice the owner cloned.  A cloned voice is only the
   * workspace default while the workspace's cloned-voice switch is on. */
  cloned?: boolean;
}

export interface Audio {
  bytes: Uint8Array;
  mime: string;
}

export type VerifyResult = { ok: true } | { ok: false; message: string };

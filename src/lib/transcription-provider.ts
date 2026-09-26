// Pick the call-mode STT provider from the user's saved preference, the
// platform, and whether an AssemblyAI key is on file. The picker never
// decides which platform supports what — the caller passes in the
// capability facts (`platform`, `appleSpeechAvailable`, `cloudSttConfigured`)
// so a test can exercise every branch without standing up an Electron host.

import type { STTProvider } from "./call-stt";

export interface TranscriptionCapability {
  /** Whether an AssemblyAI API key is configured (encrypted credential). */
  cloudSttConfigured: boolean;
  /** Whether Apple SFSpeech is reachable — only the macOS desktop build
   * ships the Swift helper, and even on macOS the helper may have failed
   * to build (Command Line Tools missing, etc.). */
  appleSpeechAvailable: boolean;
}

export interface ProviderPickerInput extends TranscriptionCapability {
  /** The user's saved preference from AppConfig. `undefined` means "let the
   * picker decide based on capability". */
  explicitPreference?: STTProvider;
  /** Host platform: "darwin" | "win32" | "linux" | anything else. */
  platform: string;
}

export type ProviderChoice =
  | { provider: "apple" }
  | { provider: "assemblyai"; reason: "platform-default" | "user-preference" | "macos-with-key" }
  | { provider: null; reason: "no-provider"; missing: "cloud-stt-key" | "apple-bridge-unavailable" };

/** Decide which provider handles a call-mode dictation session. macOS
 * defaults to Apple on-device STT when no cloud key is configured and flips
 * to AssemblyAI when one is on file; Windows/Linux always require the cloud
 * provider and fail closed with a clear reason when no key is set. The
 * user's explicit preference (when saved) wins over the platform default. */
export function pickSTTProvider(input: ProviderPickerInput): ProviderChoice {
  const { explicitPreference, cloudSttConfigured, appleSpeechAvailable, platform } = input;

  const isMacOS = platform === "darwin";
  const appleUsable = isMacOS && appleSpeechAvailable;
  const cloudUsable = cloudSttConfigured;

  // Explicit user preference wins, but only when the requested provider is
  // actually usable. A Windows user who pinned "apple" still gets a no-
  // provider result so the settings panel can surface the conflict.
  if (explicitPreference === "assemblyai" && cloudUsable) {
    return { provider: "assemblyai", reason: "user-preference" };
  }
  if (explicitPreference === "apple" && appleUsable) {
    return { provider: "apple" };
  }

  // No explicit preference — pick the best available for this platform.
  if (appleUsable && !cloudUsable) {
    return { provider: "apple" };
  }
  if (appleUsable && cloudUsable) {
    // macOS + key present: default to cloud (better accuracy, custom
    // vocabulary, server-side endpointing). Users can flip back to Apple
    // from Settings.
    return { provider: "assemblyai", reason: "macos-with-key" };
  }
  if (!appleUsable && cloudUsable) {
    return { provider: "assemblyai", reason: "platform-default" };
  }
  if (!appleUsable && !cloudUsable) {
    if (!isMacOS) {
      return { provider: null, reason: "no-provider", missing: "cloud-stt-key" };
    }
    return { provider: null, reason: "no-provider", missing: "apple-bridge-unavailable" };
  }
  // Unreachable; the explicit-preference branches above handle every case
  // that did not match a default. TypeScript still wants an exhaustive end.
  return { provider: null, reason: "no-provider", missing: "apple-bridge-unavailable" };
}
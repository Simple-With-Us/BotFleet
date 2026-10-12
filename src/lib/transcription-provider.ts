// Pick the call-mode STT provider from the user's saved preference, the
// platform, and which cloud credentials are on file. The picker never
// decides which platform supports what — the caller passes in capability
// facts so a test can exercise every branch without standing up an Electron host.

import {
  DEFAULT_CLOUD_STT_LADDER,
  type CloudSttCapabilities,
  type CloudSttProvider,
  anyCloudSttConfigured,
  emptyCloudSttCapabilities,
  isCloudSttProvider,
} from "../../shared/voice-providers.ts";
import type { STTProvider } from "./call-stt";

export interface TranscriptionCapability {
  /** Per cloud STT provider credential signal (AssemblyAI may come from the
   *  desktop encrypted store even when the harness config section is empty). */
  cloudStt: CloudSttCapabilities;
  /** Whether Apple SFSpeech is reachable — only the macOS desktop build
   * ships the Swift helper, and even on macOS the helper may have failed
   * to build (Command Line Tools missing, etc.). */
  appleSpeechAvailable: boolean;
}

export interface ProviderPickerInput extends TranscriptionCapability {
  /** The user's saved preference from AppConfig. `undefined` means "let the
   * picker decide based on capability". */
  explicitPreference?: STTProvider;
  /** Hosted cloud STT attempt order from `callStt.ladder` (hosted defaults when absent). */
  ladder?: readonly CloudSttProvider[];
  /** Host platform: "darwin" | "win32" | "linux" | anything else. */
  platform: string;
}

export type ProviderChoice =
  | { provider: "apple" }
  | { provider: CloudSttProvider; reason: "platform-default" | "user-preference" | "macos-with-key" | "ladder-fallback" }
  | { provider: null; reason: "no-provider"; missing: "cloud-stt-key" | "apple-bridge-unavailable" };

/** Cloud providers the desktop build can stream today. */
export const DESKTOP_STT_BRIDGE_CLOUD: readonly CloudSttProvider[] = ["assemblyai"];

/** Legacy single-flag input used while call sites migrate. */
export function cloudSttFromLegacy(configured: boolean): CloudSttCapabilities {
  const cap = emptyCloudSttCapabilities();
  if (configured) cap.assemblyai = true;
  return cap;
}

function isBridgedCloudProvider(id: CloudSttProvider): boolean {
  for (const bridged of DESKTOP_STT_BRIDGE_CLOUD) {
    if (bridged === id) return true;
  }
  return false;
}

/** Auto-pick respects ladder order but only returns providers the desktop can stream. */
function firstBridgedCloudProvider(cap: CloudSttCapabilities, ladder: readonly CloudSttProvider[]): CloudSttProvider | null {
  for (const id of ladder) {
    if (!cap[id] || !isBridgedCloudProvider(id)) continue;
    return id;
  }
  return null;
}

/** Decide which provider handles a call-mode dictation session. macOS
 * defaults to Apple on-device STT when no cloud key is configured and flips
 * to the first configured cloud provider when one is on file. The user's
 * explicit preference (when saved) wins over the platform default. */
export function pickSTTProvider(input: ProviderPickerInput): ProviderChoice {
  const {
    explicitPreference,
    cloudStt,
    appleSpeechAvailable,
    platform,
    ladder = DEFAULT_CLOUD_STT_LADDER,
  } = input;

  const isMacOS = platform === "darwin";
  const appleUsable = isMacOS && appleSpeechAvailable;
  const cloudUsable = anyCloudSttConfigured(cloudStt);

  if (explicitPreference && explicitPreference !== "apple" && isCloudSttProvider(explicitPreference)) {
    if (cloudStt[explicitPreference]) {
      if (isBridgedCloudProvider(explicitPreference)) {
        return { provider: explicitPreference, reason: "user-preference" };
      }
      const fallback = firstBridgedCloudProvider(cloudStt, ladder);
      if (fallback) return { provider: fallback, reason: "ladder-fallback" };
    }
  }
  if (explicitPreference === "apple" && appleUsable) {
    return { provider: "apple" };
  }

  if (appleUsable && !cloudUsable) {
    return { provider: "apple" };
  }
  if (appleUsable && cloudUsable) {
    const cloud = firstBridgedCloudProvider(cloudStt, ladder);
    if (cloud) return { provider: cloud, reason: "macos-with-key" };
  }
  if (!appleUsable && cloudUsable) {
    const cloud = firstBridgedCloudProvider(cloudStt, ladder);
    if (cloud) return { provider: cloud, reason: "platform-default" };
  }
  if (!appleUsable && !cloudUsable) {
    if (!isMacOS) {
      return { provider: null, reason: "no-provider", missing: "cloud-stt-key" };
    }
    return { provider: null, reason: "no-provider", missing: "apple-bridge-unavailable" };
  }
  return { provider: null, reason: "no-provider", missing: "apple-bridge-unavailable" };
}

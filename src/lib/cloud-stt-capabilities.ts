import {
  type CloudSttCapabilities,
  emptyCloudSttCapabilities,
} from "../../shared/voice-providers.ts";

/** Merge harness-reported cloud STT capability with the desktop AssemblyAI
 *  credential signal (still held in the encrypted store). */
export function mergeCloudSttCapabilities(
  server: CloudSttCapabilities | undefined,
  assemblyAiFromDesktop: boolean,
): CloudSttCapabilities {
  const cap = { ...emptyCloudSttCapabilities(), ...server };
  if (assemblyAiFromDesktop) cap.assemblyai = true;
  return cap;
}

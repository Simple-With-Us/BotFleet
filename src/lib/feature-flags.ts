export interface FeatureFlagConfig {
  features?: { skillRecorder?: boolean; showToolCalls?: boolean; summarizeToolCalls?: boolean };
}

/** Experimental features are available only after an explicit opt-in. */
export function skillRecorderEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.skillRecorder === true;
}

/** Tool steps in the transcript.  On by default.
 *
 * They used to be off, and the reason was sound at the time: a chip carried
 * a bare tool name, so a hundred of them said only "work happened" — which
 * the mascot already said, for free.  A step now says what it read, what it
 * ran and how long it took, and that is the difference between noise and the
 * record of a turn.  Settings still turns them off for anyone who wants only
 * the conversation. */
export function showToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.showToolCalls !== false;
}

/** Summarize consecutive tool actions into an expandable live summary progress card.
 * On by default when tool calls are shown. Set to false to show detailed stream. */
export function summarizeToolCallsEnabled(config: FeatureFlagConfig | null | undefined): boolean {
  return config?.features?.summarizeToolCalls !== false;
}

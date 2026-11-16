// Workspace master voice switch.  Absent or true means voice is on, so
// existing workspaces keep today's behavior.  False gates auto-speak, calls,
// and the TTS / STS routes.
export function voiceMasterEnabled(tts?: { enabled?: boolean } | null | undefined): boolean {
  return tts?.enabled !== false;
}

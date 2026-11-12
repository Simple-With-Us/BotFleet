/** Cloud mic-off may still supply its final formatted turn; call takeover may not edit the hidden draft. */
export function acceptComposerTranscript(detached: boolean, finalizing: boolean, callActive: boolean): boolean {
  return !callActive && (!detached || finalizing);
}

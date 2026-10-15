/** Shared detection for MiniMax Code runtime lock collisions (BOTFLEET-2K). */

export function isMcodeLockContentionMessage(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return /\block file\b/i.test(text) && /\balready being held\b/i.test(text);
}

import { createHash } from "node:crypto";

/** Deterministic per-bot desktop identity for a shared container.
 *
 * Cloud VPS shared mode already proved this shape out, and Local VM now
 * derives from the same scheme so the two runtimes cannot drift: one hash, one
 * display bound, one socket layout.  Callers pass a `screenshotPrefix` so the
 * VPS and Local VM screenshot paths stay distinct without a second hash. */
export interface BotDesktopSession {
  /** First 12 hex characters of the bot digest — the collision-resistant
   * suffix shared by the display's owner, socket, session and screenshot. */
  readonly short: string;
  readonly display: string;
  readonly socket: string;
  readonly session: string;
  readonly screenshotPath: string;
}

export function botDesktopDigest(botId: string): string {
  return createHash("sha256").update(botId).digest("hex");
}

/** Map a bot id to a distinct X display number.
 *
 * Display numbers must be bounded (10..50009) so TCP port 6000 + display
 * stays inside the 16-bit unsigned port maximum (65535) and does not fail the
 * X server launch, while remaining collision-resistant across bot ids. */
export function botDesktopDisplayFor(botId: string): string {
  const digest = botDesktopDigest(botId);
  const displayNum = 10 + (Number.parseInt(digest.slice(0, 8), 16) % 50000);
  return `:${displayNum}`;
}

export function botDesktopSession(botId: string, screenshotPrefix: string): BotDesktopSession {
  const digest = botDesktopDigest(botId);
  const short = digest.slice(0, 12);
  return {
    short,
    display: botDesktopDisplayFor(botId),
    socket: `/run/user/1000/botfleet-cua-${short}.sock`,
    session: `bf-${short}`,
    screenshotPath: `/tmp/botfleet-${screenshotPrefix}-${short}.png`,
  };
}

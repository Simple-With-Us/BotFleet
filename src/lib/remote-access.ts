/** Remote Access copy.
 *
 *  Every string here describes THIS install and nothing else.  There is no
 *  host, no person, and no tunnel name baked in: the address comes from the
 *  config this Mac actually saved, and the card is not rendered at all when
 *  there is no address to show.  An earlier revision hard-coded one
 *  operator's personal domain (assembled from fragments, which hid nothing)
 *  and his name in the blurb, so every install of a public app pointed at
 *  somebody's home server.  Do not reintroduce a literal here — read
 *  `ingress.publicUrl` out of the config instead. */

/** What a saved `ingress.publicUrl` has to look like to be usable.
 *
 *  The same shape the server's ingress probe accepts, so a value that renders
 *  here is a value the Test Connection button can actually probe. */
const REMOTE_URL_PATTERN = /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i;

export const REMOTE_ACCESS_HEADING = "Remote Access";
export const REMOTE_URL_LABEL = "Remote URL";
export const REMOTE_ACCESS_BLURB =
  "Opens BotFleet on this Mac at the address below, through the tunnel this Mac is configured to use.  " +
  "Sign in with whatever your tunnel puts in front of it.  The health check stays public.";

export const REMOTE_ACCESS_UNCONFIGURED_BLURB =
  "This Mac has no remote address configured, so there is nothing to open.  " +
  "Set one in Settings → General → Custom Webhook Domain to turn Remote Access on.";

export const COMPANION_GATEWAY_LABEL = "Companion Gateway";
export const COMPANION_GATEWAY_BLURB =
  "Phone pairing uses its own address, which is set up separately.  That path is separate from Remote Access.";

/**
 * The install's own remote address, or null when there is not a usable one.
 *
 * Returning null rather than a placeholder is the point: a card with no
 * honest answer is worse than no card, and a card with somebody else's
 * answer is a privacy bug.
 */
export function normalizeRemoteUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (!REMOTE_URL_PATTERN.test(trimmed)) return null;
  // Drop a trailing slash so the same configured address always renders, and
  // probes, as one string.
  return trimmed.replace(/\/+$/, "");
}

/** HTML/JSX collapses ASCII double-spaces.  Convert Designer copy to NBSP+space. */
export function sentenceGapHtml(text: string): string {
  return text.replace(/([.!?]) {2}(?=\S)/g, "$1  ");
}

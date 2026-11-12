// The packaged app serves its built UI from the harness (window → :8799 for
// everything).  This maps a request path onto a file inside that folder, or
// nothing at all when the request would land outside it.
//
// Containment is decided on real paths: `..`, percent-encoded dots, and a
// symlink planted inside the folder all resolve before the comparison, so
// none of them can reach past it.  The harness is loopback-only, which is
// why this was tolerable for a while — and why it should not stay that way.
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

/** The real path of the file to serve, or null when the request is outside
 * `root`, names the folder itself, or does not exist.  A null means "treat
 * as not found" — the caller's SPA fallback is the right answer for all
 * three, and it never discloses which one happened. */
export function resolveStaticFile(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^[/\\]+/, "");
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(resolve(realRoot, relative));
  } catch {
    return null;
  }
  if (realFile === realRoot) return null;
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  return realFile.startsWith(prefix) ? realFile : null;
}

/** Return Cache-Control header appropriate for the static resource.
 * Hashed static bundle assets under `/assets/` are immutable and safe to
 * cache long-term.  HTML and SPA fallback pages must never be cached so
 * users receive updates promptly. */
export function staticCacheControl(urlPath: string): string {
  const normalized = urlPath.replace(/^[/\\]+/, "/");
  if (normalized.startsWith("/assets/") || normalized.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
}

/** Return default response headers for serving a static file. */
export function staticFileHeaders(urlPath: string): Record<string, string> {
  return {
    "Cache-Control": staticCacheControl(urlPath),
  };
}

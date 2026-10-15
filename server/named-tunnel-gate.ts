import type { IncomingMessage } from "node:http";

/** Header names Cloudflare adds when a request reached the harness through the
 * named tunnel or Access edge rather than a local desktop or sidecar hop. */
const CLOUDFLARE_TUNNEL_MARKERS = [
  "cf-ray",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-visitor",
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
] as const;

/** True when the request carries Cloudflare edge markers cloudflared forwards to
 * the loopback harness.  Local callers (renderer, CLIs, companion replay) do
 * not send these headers. */
export function arrivedViaCloudflareTunnel(req: IncomingMessage): boolean {
  for (const name of CLOUDFLARE_TUNNEL_MARKERS) {
    const raw = req.headers[name];
    if (raw === undefined) continue;
    if (Array.isArray(raw)) {
      if (raw.some((value) => value.length > 0)) return true;
      continue;
    }
    if (raw.length > 0) return true;
  }
  return false;
}

export function isMutatingHarnessApiRequest(method: string, path: string): boolean {
  return (
    path.startsWith("/api/") &&
    !["GET", "HEAD", "OPTIONS"].includes(method) &&
    path !== "/api/runtime/quiesce"
  );
}

export const NAMED_TUNNEL_MUTATION_FORBIDDEN =
  "forbidden: named tunnel cannot mutate the harness until remote auth lands";

// The Box gateway's own vocabulary: where it lives, and the short-lived grant
// a bot's computer adapter presents to it.
//
// This is a leaf module on purpose, and the reason is the renderer bundle.
// `src/lib/cloud-backend.ts` imports a VALUE from `server/computer-grants.ts`,
// so anything `computer-grants.ts` imports by value lands in the browser graph.
// When the grant helpers lived in `container-computer.ts`, that pulled
// `node:path` (through `env-path.ts`) into the renderer build and vite refused
// it: "join is not exported by __vite-browser-external".  A grant is about a
// credential and an endpoint, which needs no filesystem and no child process,
// so it belongs here where it can be imported from either side.

import { randomBytes } from "node:crypto";

/** Where the gateway is mounted.  A loopback path on the harness itself, never
 *  the provider: the account-wide key stays on this side of the socket. */
export const BOX_GATEWAY_PATH = "/api/local/box-gateway";

/** How long one mount's grant is good for.  Long enough for a turn, short
 *  enough that a leaked one is not a standing key. */
export const BOX_GATEWAY_TTL_MS = 4 * 60 * 60 * 1000;

/** How many grants a long-lived harness holds at once. */
export const MAX_BOX_GATEWAY_GRANTS = 512;

export interface MintedBoxGrant {
  readonly url: string;
  readonly token: string;
}

interface BoxGatewayGrantRecord {
  readonly botId: string;
  readonly boxId: string;
  readonly expiresAt: number;
}

/** The live grants.  Exported for the two test seams in
 *  `container-computer.ts` (revoke-one, reset-all), not for anything else. */
export const boxGatewayGrants = new Map<string, BoxGatewayGrantRecord>();

/** The loopback base a child should send Box calls to, or "" when this harness
 *  has no control endpoint to derive one from.  Empty means the adapter has
 *  nowhere to go, which fails closed: the child cannot fall back to the
 *  provider with a raw key. */
export function boxGatewayUrl(control: { url: string } | undefined): string {
  if (!control?.url) return "";
  try {
    return `${new URL(control.url).origin}${BOX_GATEWAY_PATH}`;
  } catch {
    return "";
  }
}

/** Mint the grant one mounted box is reachable with. */
export function mintBoxGatewayGrant(
  botId: string,
  boxId: string,
  gatewayUrl: string,
  now = Date.now(),
): MintedBoxGrant {
  const token = randomBytes(24).toString("hex");
  boxGatewayGrants.set(token, { botId, boxId, expiresAt: now + BOX_GATEWAY_TTL_MS });
  // Map iterates in insertion order, so this drops the oldest first — a
  // long-lived harness with many turns cannot grow the table without bound.
  while (boxGatewayGrants.size > MAX_BOX_GATEWAY_GRANTS) {
    const oldest = boxGatewayGrants.keys().next();
    if (oldest.done) break;
    boxGatewayGrants.delete(oldest.value);
  }
  return { url: gatewayUrl, token };
}

/** The bot and box a presented token names, or null when it is unknown or
 *  expired.  The gateway calls this, and it is the only place a grant is
 *  turned back into an identity. */
export function resolveBoxGatewayGrant(
  token: string | undefined,
  now = Date.now(),
): BoxGatewayGrantRecord | null {
  if (!token) return null;
  const record = boxGatewayGrants.get(token);
  if (!record) return null;
  if (record.expiresAt <= now) {
    boxGatewayGrants.delete(token);
    return null;
  }
  return record;
}

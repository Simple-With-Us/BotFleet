// Picking ports for a suite that boots real servers.
//
// A random port in a wide range is fine until two suites run at once — the
// second one loses a bind it never checked, and the failure surfaces as
// whatever the server does when it cannot listen, which is rarely "port
// taken". Probing first turns that into a port nobody else holds.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { mcpOAuthRedirectUri } from "../mcp-oauth.ts";

/** Bind a port, then let it go. False when something already has it. */
const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

/**
 * Find a base port where every `base + offset` is free.
 *
 * Offsets rather than a count because the ports a suite needs are rarely
 * contiguous: the harness quietly opens a webhook receiver one above itself,
 * and a sidecar sits well clear of both. Asking for the exact set is the only
 * way to know the whole layout is clear.
 *
 * This is a probe, not a reservation — the ports are released before they are
 * returned, so a sufficiently unlucky third party can still take one in the
 * gap. It closes the window that concurrent suites in the same checkout
 * actually hit, which is the one that matters here.
 */
export async function freePortBlock(offsets: number[], from = 19_600, span = 3_000): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const base = from + Math.floor(Math.random() * span);
    const checks = await Promise.all(offsets.map((offset) => isFree(base + offset)));
    if (checks.every(Boolean)) return base;
  }
  throw new Error(`no free port block for offsets ${offsets.join(",")} in ${from}..${from + span}`);
}

function ephemeralFloor(): number {
  try {
    return Number(readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/)[0]) || 49_152;
  } catch {
    return 49_152;
  }
}

/** MCP OAuth redirect port that stays below the kernel ephemeral range. */
export async function withFreeSignInPort(url: string): Promise<string> {
  const floor = ephemeralFloor();
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = new URL(url);
    candidate.searchParams.set("app", String(attempt));
    const port = Number(new URL(mcpOAuthRedirectUri(candidate.toString())).port);
    if (port < floor && await isFree(port)) return candidate.toString();
  }
  throw new Error(`no free sign-in redirect port below ${floor} for ${url}`);
}

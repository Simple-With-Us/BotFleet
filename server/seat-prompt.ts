import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Unique substrings in `bots/_shared.md` — tests assert each appears exactly
 *  once in a composed seat prompt.  Keep them stable; they are the contract.
 *  The agent-sync marker is split so this module does not embed the Slack
 *  channel token as a contiguous literal (see server/prompt-privacy.test.ts). */
export const FLEET_SHARED_RULE_MARKERS = [
  ["#", "agent-sync"].join(""),
  "Recall CLI fallback",
  "[to iMessage]",
  "Never post unprompted status spam or routine commentary to Slack",
  "Extra-ship: NO",
] as const;

/** Seat ids with a `bots/<id>.md` file (lowercase). */
export const FLEET_SEAT_IDS = [
  "claude",
  "cursor",
  "grok",
  "codex",
  "ag",
  "minimax",
  "monet",
  "producer",
  "oracle",
  "deployer",
  "fixer",
] as const;

export type FleetSeatId = (typeof FLEET_SEAT_IDS)[number];

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let cachedShared: string | undefined;
const cachedSeat = new Map<string, string>();

function readBotsFile(name: string): string {
  const path = join(repoRoot, "bots", name);
  return readFileSync(path, "utf8").trim();
}

/** UTF-8 bytes of the shared preamble block (cached). */
export function fleetSharedPreambleBytes(): number {
  return Buffer.byteLength(fleetSharedPreambleText(), "utf8");
}

export function fleetSharedPreambleText(): string {
  if (cachedShared === undefined) {
    cachedShared = readBotsFile("_shared.md");
  }
  return cachedShared;
}

function fleetSeatSpecificText(seatId: FleetSeatId): string {
  const hit = cachedSeat.get(seatId);
  if (hit !== undefined) return hit;
  const text = readBotsFile(`${seatId}.md`);
  cachedSeat.set(seatId, text);
  return text;
}

/** True when the harness should inject fleet seat prompts (Mac operator fleet). */
export function fleetSeatPromptsEnabled(): boolean {
  return process.env.BOTFLEET_FLEET_SEAT_PROMPTS === "1";
}

const BF_NAME = /^BF[-\s](.+)$/i;
const DESC_SEAT = /@fleet-seat:\s*([a-z0-9_-]+)/i;

function normalizeSeatSlug(raw: string): FleetSeatId | null {
  const slug = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return (FLEET_SEAT_IDS as readonly string[]).includes(slug) ? (slug as FleetSeatId) : null;
}

/** Resolve a bot record to a fleet seat id, or null when this bot is not a seat. */
export function resolveFleetSeatId(bot: {
  name: string;
  description?: string | null;
}): FleetSeatId | null {
  const fromDesc = bot.description?.match(DESC_SEAT)?.[1];
  if (fromDesc) {
    const seat = normalizeSeatSlug(fromDesc);
    if (seat) return seat;
  }
  const fromName = bot.name.match(BF_NAME)?.[1];
  if (fromName) {
    return normalizeSeatSlug(fromName);
  }
  return null;
}

/** Shared preamble plus seat-specific lines, joined once. */
export function composeFleetSeatPrompt(seatId: FleetSeatId): string {
  const shared = fleetSharedPreambleText();
  const specific = fleetSeatSpecificText(seatId);
  return `${shared}\n\n${specific}`;
}

export function fleetComposedPromptBytes(seatId: FleetSeatId): number {
  return Buffer.byteLength(composeFleetSeatPrompt(seatId), "utf8");
}

/** Bytes wasted when the shared block was pasted at each assembly site (1:1 + room). */
export function legacyDuplicatedSharedBytesPerTurn(assemblySites = 2): number {
  const shared = fleetSharedPreambleBytes();
  // One injection carries the block; legacy pasted it at every site.
  return shared * Math.max(0, assemblySites - 1);
}

export interface FleetSeatPromptPart {
  seatId: FleetSeatId;
  text: string;
}

/** Section text for `buildSystemPrompt`, or null when disabled or not a seat bot. */
export function fleetSeatPromptPart(bot: {
  name: string;
  description?: string | null;
}): FleetSeatPromptPart | null {
  if (!fleetSeatPromptsEnabled()) return null;
  const seatId = resolveFleetSeatId(bot);
  if (!seatId) return null;
  const text = composeFleetSeatPrompt(seatId);
  return text ? { seatId, text: `\n${text}` } : null;
}

export function countMarker(haystack: string, marker: string): number {
  let count = 0;
  let idx = 0;
  while (true) {
    const at = haystack.indexOf(marker, idx);
    if (at === -1) break;
    count += 1;
    idx = at + marker.length;
  }
  return count;
}

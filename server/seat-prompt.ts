import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Unique substrings in `bots/_shared.md` — tests assert each appears exactly
 *  once in a composed seat prompt.  Keep them stable; they are the contract. */
export const FLEET_SHARED_RULE_MARKERS = [
  "fleet Slack coordination channel",
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

let cachedBotsRoot: string | undefined;
let cachedShared: string | undefined;
const cachedSeat = new Map<string, string>();

/** Directory containing `_shared.md` and seat files — packaged, dev, and test. */
export function fleetBotsDirectory(): string {
  if (cachedBotsRoot !== undefined) return cachedBotsRoot;
  const fromEnv = process.env.OMB_BOTS_DIR?.trim();
  if (fromEnv) {
    cachedBotsRoot = fromEnv;
    return fromEnv;
  }
  const resources = process.env.OMB_RESOURCES_PATH?.trim();
  if (resources) {
    const underResources = join(resources, "bots");
    if (existsSync(join(underResources, "_shared.md"))) {
      cachedBotsRoot = underResources;
      return underResources;
    }
  }
  const moduleDir = fileURLToPath(new URL(".", import.meta.url));
  const candidates = [
    join(moduleDir, "..", "bots"),
    join(process.cwd(), "bots"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "_shared.md"))) {
      cachedBotsRoot = dir;
      return dir;
    }
  }
  cachedBotsRoot = candidates[0]!;
  return cachedBotsRoot;
}

function readBotsFile(name: string): string | null {
  try {
    return readFileSync(join(fleetBotsDirectory(), name), "utf8").trim();
  } catch {
    return null;
  }
}

/** UTF-8 bytes of the shared preamble block (cached). */
export function fleetSharedPreambleBytes(): number {
  return Buffer.byteLength(fleetSharedPreambleText(), "utf8");
}

export function fleetSharedPreambleText(): string {
  if (cachedShared === undefined) {
    const text = readBotsFile("_shared.md");
    if (!text) {
      throw new Error(`Fleet seat shared preamble missing under ${fleetBotsDirectory()}`);
    }
    cachedShared = text;
  }
  return cachedShared;
}

function fleetSeatSpecificText(seatId: FleetSeatId): string {
  const hit = cachedSeat.get(seatId);
  if (hit !== undefined) return hit;
  const text = readBotsFile(`${seatId}.md`);
  if (!text) {
    throw new Error(`Fleet seat file missing: ${seatId}.md under ${fleetBotsDirectory()}`);
  }
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
  for (const seatId of FLEET_SEAT_IDS) {
    if (seatId === slug) return seatId;
  }
  return null;
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

/** Like `composeFleetSeatPrompt`, but returns null when assets are missing (no throw). */
export function tryComposeFleetSeatPrompt(seatId: FleetSeatId): string | null {
  const shared = readBotsFile("_shared.md");
  const specific = readBotsFile(`${seatId}.md`);
  if (!shared || !specific) return null;
  return `${shared}\n\n${specific}`;
}

export function fleetComposedPromptBytes(seatId: FleetSeatId): number {
  return Buffer.byteLength(composeFleetSeatPrompt(seatId), "utf8");
}

/** Bytes wasted when the shared block was pasted at each assembly site (1:1 + room). */
export function legacyDuplicatedSharedBytesPerTurn(assemblySites = 2): number {
  const shared = fleetSharedPreambleBytes();
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
  const text = tryComposeFleetSeatPrompt(seatId);
  if (!text) return null;
  return { seatId, text: `\n${text}` };
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

/** Test-only: drop cached roots so env overrides take effect. */
export function resetFleetSeatPromptCacheForTests(): void {
  cachedBotsRoot = undefined;
  cachedShared = undefined;
  cachedSeat.clear();
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BOTFLEET_ROLES,
  fleetSeatPromptsEnabled,
  resolveBotfleetRole,
  type KnownBotfleetRole,
} from "./launch-identity.ts";

export { fleetSeatPromptsEnabled };

/** Unique substrings in `bots/_shared.md` — tests assert each appears exactly
 *  once in a composed seat prompt.  Keep them stable; they are the contract. */
export const FLEET_SHARED_RULE_MARKERS = [
  "fleet Zulip coordination channel",
  "Recall CLI fallback",
  "[to iMessage]",
  "Never post unprompted status spam or routine commentary to Zulip",
  "Extra-ship: NO",
] as const;

/** Seat ids with a `bots/<id>.md` file (lowercase): the ten BotFleet roles. */
export const FLEET_SEAT_IDS = BOTFLEET_ROLES.map((role) => role.id);

export type FleetSeatId = KnownBotfleetRole["id"];

let cachedBotsRoot: string | undefined;
let cachedShared: string | undefined;
let cachedSeatTemplate: string | undefined;
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

/** Resolve a bot record to a fleet seat id, or null when this bot is not a seat.
 *  The same rule decides the seat in the bot's environment (launch-identity.ts). */
export function resolveFleetSeatId(bot: {
  name: string;
  description?: string | null;
}): FleetSeatId | null {
  return resolveBotfleetRole(bot)?.id ?? null;
}

function fleetSeatTemplate(): string {
  if (cachedSeatTemplate === undefined) {
    const text = readBotsFile("_seat.md");
    if (!text) {
      throw new Error(`Fleet seat template missing under ${fleetBotsDirectory()}`);
    }
    cachedSeatTemplate = text;
  }
  return cachedSeatTemplate;
}

/** The seat sentence for one role: the template with the role's name and seat. */
function renderSeatSection(template: string, seatId: FleetSeatId): string {
  const role = BOTFLEET_ROLES.find((candidate) => candidate.id === seatId)!;
  return template.replaceAll("{name}", role.name).replaceAll("{seat}", role.seat);
}

/** The seat sentence, the shared preamble, then the role's own lines, joined once. */
export function composeFleetSeatPrompt(seatId: FleetSeatId): string {
  const seat = renderSeatSection(fleetSeatTemplate(), seatId);
  const shared = fleetSharedPreambleText();
  const specific = fleetSeatSpecificText(seatId);
  return `${seat}\n\n${shared}\n\n${specific}`;
}

/** Like `composeFleetSeatPrompt`, but returns null when assets are missing (no throw). */
export function tryComposeFleetSeatPrompt(seatId: FleetSeatId): string | null {
  const template = readBotsFile("_seat.md");
  const shared = readBotsFile("_shared.md");
  const specific = readBotsFile(`${seatId}.md`);
  if (!template || !shared || !specific) return null;
  return `${renderSeatSection(template, seatId)}\n\n${shared}\n\n${specific}`;
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
  cachedSeatTemplate = undefined;
  cachedSeat.clear();
}

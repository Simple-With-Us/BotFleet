// Per-bot Zulip state on disk: `DATA_DIR/zulip/<botId>.json`, mode 600.
//
// It is what makes a restart (and the harness restarts often) neither drop
// nor repeat a wake:
//   - `cursor`   the highest message id this bot has classified.  A queue
//                re-registered after an outage backfills DMs and mentions
//                above it, and anything at or below it was already decided.
//   - `handled`  a bounded ring of wake-worthy ids that were dispatched or
//                dropped by policy: the de-duplication record, so a message
//                seen twice (a backfill overlapping a live event, a restart
//                between dispatch and save) never wakes the bot twice.
//   - `pending`  units waiting for the bot to be free.  Saved with the cursor
//                in one atomic write, so a crash can never advance the cursor
//                past a wake it had not yet queued.
//   - `wakes` and `chains`  the budget and loop-guard ledgers.
//   - `dms`      when each outbound DM that was not a reply went out: the
//                per-bot DM rate limit's ledger.

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import type { ZulipWorkUnit } from "./types.ts";

export const HANDLED_RING_LIMIT = 2000;
const WAKE_LEDGER_MS = 24 * 3600_000;
const WAKE_LEDGER_LIMIT = 500;

export interface ZulipWakeRecord {
  at: number;
  kind: "owner" | "peer";
  /** originKey of the conversation it woke for. */
  key: string;
}

export interface ZulipBotState {
  version: 1;
  role: string;
  userId?: number;
  cursor: number | null;
  handled: number[];
  pending: ZulipWorkUnit[];
  wakes: ZulipWakeRecord[];
  /** originKey -> peer wakes since the last owner message there. */
  chains: Record<string, number>;
  /** ms since the epoch of each DM sent that was not a reply to the origin. */
  dms: number[];
}

export function emptyState(role: string): ZulipBotState {
  return { version: 1, role, cursor: null, handled: [], pending: [], wakes: [], chains: {}, dms: [] };
}

function fileName(botId: string): string {
  return `${botId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}

// The file on disk, parsed at the boundary.  Each ledger is parsed on its own
// (`.catch`), so one damaged field costs that ledger and not the cursor.
const originSchema = z.union([
  z.object({ kind: z.literal("stream"), channel: z.string(), topic: z.string(), streamId: z.number().optional().catch(undefined) }),
  z.object({ kind: z.literal("dm"), userId: z.number() }),
]);
const itemSchema = z.object({
  id: z.number(),
  senderId: z.number(),
  senderName: z.string().catch(""),
  senderIsBot: z.boolean().catch(true),
  owner: z.boolean().catch(false),
  ownerViaApi: z.boolean().catch(false),
  content: z.string(),
  timestamp: z.number().catch(0),
});
const unitSchema = z.object({
  origin: originSchema,
  items: z.array(itemSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  attempts: z.number(),
  notBefore: z.number(),
});
const stateFileSchema = z.object({
  version: z.literal(1),
  role: z.string(),
  userId: z.number().optional().catch(undefined),
  cursor: z.number().int().nullable().catch(null),
  handled: z.array(z.number()).catch([]),
  pending: z.array(unitSchema).catch([]),
  wakes: z
    .array(z.object({ at: z.number(), kind: z.enum(["owner", "peer"]), key: z.string() }))
    .catch([]),
  chains: z.record(z.string(), z.number()).catch({}),
  // Added after the first state files were written: absent reads as empty.
  dms: z.array(z.number()).optional().catch(undefined),
});

export class ZulipStateStore {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "zulip");
  }

  /** The saved state for this bot, or a fresh one.  A state saved for a
   *  different role (the bot was re-mapped to another Zulip identity) starts
   *  fresh: the old cursor and ring belong to someone else's mailbox. */
  load(botId: string, role: string): ZulipBotState {
    let text: string;
    try {
      text = readFileSync(join(this.dir, fileName(botId)), "utf8");
    } catch {
      return emptyState(role);
    }
    let parsed;
    try {
      parsed = stateFileSchema.safeParse(JSON.parse(text));
    } catch {
      return emptyState(role);
    }
    if (!parsed.success || parsed.data.role !== role) return emptyState(role);
    const { userId, dms, ...rest } = parsed.data;
    const state: ZulipBotState = { ...rest, dms: dms ?? [] };
    if (userId !== undefined) state.userId = userId;
    return state;
  }

  save(botId: string, state: ZulipBotState, now = Date.now()): void {
    // Bound every ledger before it reaches disk.
    if (state.handled.length > HANDLED_RING_LIMIT) state.handled = state.handled.slice(-HANDLED_RING_LIMIT);
    state.wakes = state.wakes.filter((w) => now - w.at < WAKE_LEDGER_MS).slice(-WAKE_LEDGER_LIMIT);
    state.dms = (state.dms ?? []).filter((at) => now - at < WAKE_LEDGER_MS).slice(-WAKE_LEDGER_LIMIT);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      /* best effort: the files themselves are 600 */
    }
    writeFileAtomic(join(this.dir, fileName(botId)), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }
}

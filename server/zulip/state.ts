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
//   - `notices`  owner DMs refused by that rate limit, queued for resend when
//                the window resets.  Persisted like every other ledger, so a
//                restart cannot drop one; the text stays in this mode-600
//                file, the same protection the DM ledger gets.

import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { canonicalZulipRole } from "../launch-identity.ts";
import type { ZulipInboundItem, ZulipOrigin } from "./types.ts";

export const HANDLED_RING_LIMIT = 2000;
const WAKE_LEDGER_MS = 24 * 3600_000;
const WAKE_LEDGER_LIMIT = 500;

export interface ZulipWakeRecord {
  at: number;
  kind: "owner" | "peer";
  /** originKey of the conversation it woke for. */
  key: string;
}


export const PENDING_NOTICE_LIMIT = 50;
/** Terminal (never-deliverable) notice records kept as evidence. */
export const TERMINAL_NOTICE_LIMIT = 10;
/** Resend attempts before a notice is escalated instead of retried. */
export const MAX_NOTICE_ATTEMPTS = 8;

// The state shape is z.infer<typeof stateFileSchema>, declared below the
// schema: never a hand-maintained twin that can drift from the boundary.

export function emptyState(role: string): ZulipBotState {
  return { version: 1, role, cursor: null, handled: [], pending: [], wakes: [], chains: {}, dms: [], notices: [] };
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
  via: z.enum(["mention", "dm", "followed"]).optional().catch(undefined),
  // Plugin-platform routing: the dispatcher's hint and the role that
  // routed it.  Absent reads as none, so old state files still parse.
  pluginHint: z.string().max(2000).optional().catch(undefined),
  routedFrom: z.string().max(128).optional().catch(undefined),
});
const unitSchema = z.object({
  origin: originSchema,
  items: z.array(itemSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
  attempts: z.number(),
  notBefore: z.number(),
  held: z.string().optional(),
  dropped: z.number().optional(),
}).strict();
/** One queued owner notice, parsed on its own so a single damaged entry can
 *  be quarantined (with its raw form preserved privately) instead of costing
 *  the whole ledger. */
export const noticeEntrySchema = z.object({
  at: z.number(),
  userId: z.number(),
  text: z.string().max(9500),
  attempts: z.number().int().nonnegative().catch(0),
  nextAt: z.number().optional().catch(undefined),
  failed: z.string().max(500).optional().catch(undefined),
}).strict();

/** An owner DM the hourly cap refused, held for resend after the window. */
export type ZulipPendingNotice = z.infer<typeof noticeEntrySchema>;

export const stateFileSchema = z.object({
  version: z.literal(1),
  role: z.string(),
  userId: z.number().optional().catch(undefined),
  cursor: z.number().int().nullable().catch(null),
  handled: z.array(z.number()).catch([]),
  // Pending work units, per-entry catch like notices: one invalid unit
  // quarantines as null and is counted and archived on load, never silently
  // stripped and never at the cost of the valid units around it.
  pending: z
    .array(unitSchema.nullable().catch(null))
    .catch([])
    .transform((units) => units.filter((unit): unit is z.infer<typeof unitSchema> => unit !== null)),
  wakes: z
    .array(z.object({ at: z.number(), kind: z.enum(["owner", "peer"]), key: z.string() }))
    .catch([]),
  chains: z.record(z.string(), z.number()).catch({}),
  // Added after the first state files were written: absent reads as empty.
  dms: z.array(z.number()).optional().catch(undefined).transform((value) => value ?? []),
  // Queued owner notices, absent on older files.  PER-ENTRY catch: one
  // invalid entry quarantines as null and is counted on load, it never
  // erases the valid entries around it.
  notices: z
    .array(noticeEntrySchema.nullable().catch(null))
    .optional()
    .catch(undefined)
    .transform((entries) => (entries ?? []).filter((entry): entry is ZulipPendingNotice => entry !== null)),
  noticesDroppedOnLoad: z.number().int().nonnegative().optional().catch(undefined),
  noticesArchived: z.number().int().nonnegative().optional().catch(undefined),
  // Units dropped across loads because they failed the schema - a count
  // only, never the content: the durable flag that a load was lossy.  The
  // raw units themselves are preserved in the private archive file.
  pendingDroppedOnLoad: z.number().int().nonnegative().optional().catch(undefined),
});

/** The live state shape: exactly what stateFileSchema produces at the
 *  boundary. */
export type ZulipBotState = z.infer<typeof stateFileSchema>;

export class ZulipStateStore {
  readonly dir: string;

  private readonly onArchiveError?: (message: string) => void;

  constructor(dataDir: string, onArchiveError?: (message: string) => void) {
    this.onArchiveError = onArchiveError;
    this.dir = join(dataDir, "zulip");
  }

  /** The saved state for this bot, or a fresh one.  A state saved for a
   *  different role (the bot was re-mapped to another Zulip identity) starts
   *  fresh: the old cursor and ring belong to someone else's mailbox.  The one
   *  exception is a rename: a file whose canonical fold is this role keeps its
   *  ledgers, relabelled, so the next save writes the canonical role. */
  load(botId: string, role: string): ZulipBotState {
    let text: string;
    try {
      text = readFileSync(join(this.dir, fileName(botId)), "utf8");
    } catch {
      return emptyState(role);
    }
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(text);
    } catch {
      return emptyState(role);
    }
    const parsed = stateFileSchema.safeParse(rawJson);
    if (!parsed.success) return emptyState(role);
    const savedRole = parsed.data.role;
    if (savedRole !== role && canonicalZulipRole(savedRole) !== role) {
      return emptyState(role);
    }
    // Read the raw notices field before the schema view: a notices field
    // that is not an array at all is lost to the schema in one piece (the
    // whole field becomes undefined), and only the raw value can be
    // quarantined and counted instead of silently erased.
    // SAFETY: the parsed JSON is only ever inspected field-by-field here;
    // each field read off it is re-validated as unknown before use.
    const rawRecord =
      rawJson !== null && typeof rawJson === "object" && !Array.isArray(rawJson)
        ? (rawJson as { notices?: unknown; pending?: unknown })
        : {};
    const rawField: unknown = rawRecord.notices;
    const nonArrayNotices = rawField !== undefined && rawField !== null && !Array.isArray(rawField);
    const rawEntries: unknown[] = Array.isArray(rawField) ? rawField : [];
    const rawPendingField: unknown = rawRecord.pending;
    const nonArrayPending = rawPendingField !== undefined && rawPendingField !== null && !Array.isArray(rawPendingField);
    const rawPendingEntries: unknown[] = Array.isArray(rawPendingField) ? rawPendingField : [];
    const { userId, noticesDroppedOnLoad, pendingDroppedOnLoad, ...rest } = parsed.data;
    const state: ZulipBotState = { ...rest, role };
    if (userId !== undefined) state.userId = userId;
    const droppedTotal = (noticesDroppedOnLoad ?? 0) + (rawEntries.length - parsed.data.notices.length) + (nonArrayNotices ? 1 : 0);
    if (droppedTotal > 0) state.noticesDroppedOnLoad = droppedTotal;
    const droppedPendingTotal =
      (pendingDroppedOnLoad ?? 0) + (rawPendingEntries.length - parsed.data.pending.length) + (nonArrayPending ? 1 : 0);
    if (droppedPendingTotal > 0) state.pendingDroppedOnLoad = droppedPendingTotal;
    // Quarantine the raw invalid entries BEFORE any save can overwrite the
    // file: private, mode-600, never logged, never posted.
    const invalidRaw = rawEntries.filter((entry) => !noticeEntrySchema.safeParse(entry).success);
    if (nonArrayNotices) invalidRaw.push(rawField);
    if (invalidRaw.length > 0) this.archive(botId, "schema-invalid-on-load", invalidRaw);
    // Strict units: an unknown key fails the entry, and the raw original is
    // quarantined privately and counted - never silently stripped.
    const invalidPending = rawPendingEntries.filter((entry) => !unitSchema.safeParse(entry).success);
    if (nonArrayPending) invalidPending.push(rawPendingField);
    if (invalidPending.length > 0) this.archive(botId, "schema-invalid-on-load", invalidPending);
    return state;
  }

  /** Preserve queue-cap-trimmed inbound items in the same private archive
   *  as quarantined notices: accepted input is evidence and is never
   *  destroyed without a private copy.  Throws on write failure so the
   *  caller keeps the items instead of dropping them silently. */
  archiveDroppedItems(botId: string, origin: ZulipOrigin, items: ZulipInboundItem[]): void {
    this.archive(botId, "queue-cap-item-drop", items.map((item) => ({ origin, item })));
  }

  /** Append records to the bot's private notices archive (mode-600 JSONL
   *  next to the state file): the evidence for anything the ledger no
   *  longer carries.  Contents are never logged or posted. */
  private archive(botId: string, reason: string, entries: unknown[]): void {
    if (entries.length === 0) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // best effort, as with the state file
    }
    const path = join(this.dir, fileName(botId).replace(/\.json$/, ".notices-archive.jsonl"));
    const lines = entries.map((entry) => JSON.stringify({ archivedAt: Date.now(), reason, entry })).join("\n") + "\n";
    // Follow no link: a swapped archive path must never redirect the
    // write.  Open with O_NOFOLLOW, then prove the handle is the same
    // regular, single-link file the path still names - a race can swap it
    // between the two checks, so handle and path must agree on dev + inode.
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const handleStat = fstatSync(fd);
      const pathStat = lstatSync(path);
      if (
        !handleStat.isFile() ||
        !pathStat.isFile() ||
        handleStat.nlink !== 1 ||
        pathStat.nlink !== 1 ||
        handleStat.dev !== pathStat.dev ||
        handleStat.ino !== pathStat.ino
      ) {
        throw new Error(`archive path ${path} is not a plain single-link file; refusing to append`);
      }
      writeSync(fd, lines);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort
    }
  }

  save(botId: string, state: ZulipBotState, now = Date.now()): void {
    // Bound every ledger before it reaches disk.
    if (state.handled.length > HANDLED_RING_LIMIT) state.handled = state.handled.slice(-HANDLED_RING_LIMIT);
    state.wakes = state.wakes.filter((w) => now - w.at < WAKE_LEDGER_MS).slice(-WAKE_LEDGER_LIMIT);
    state.dms = (state.dms ?? []).filter((at) => now - at < WAKE_LEDGER_MS).slice(-WAKE_LEDGER_LIMIT);
    // Deliverable notices are already bounded by the enqueue refusal; keep
    // them all, plus the most recent terminal records as evidence.  Anything
    // pruned is archived privately first and counted - pruning is archival,
    // never silent loss and never resolution of the obligation.
    const all = state.notices ?? [];
    const failed = all.filter((n) => n.failed);
    const pruned = failed.slice(0, Math.max(0, failed.length - TERMINAL_NOTICE_LIMIT));
    const keepFailed = new Set(failed.slice(-TERMINAL_NOTICE_LIMIT));
    let bounded = all.filter((n) => !n.failed || keepFailed.has(n));
    if (bounded.length > PENDING_NOTICE_LIMIT + TERMINAL_NOTICE_LIMIT) {
      pruned.push(...bounded.slice(0, bounded.length - (PENDING_NOTICE_LIMIT + TERMINAL_NOTICE_LIMIT)));
      bounded = bounded.slice(-(PENDING_NOTICE_LIMIT + TERMINAL_NOTICE_LIMIT));
    }
    if (pruned.length > 0) {
      try {
        this.archive(botId, "notice-record-pruned", pruned);
        state.noticesArchived = (state.noticesArchived ?? 0) + pruned.length;
      } catch (error) {
        // Archival failed: the pruned records are NOT dropped - they stay in
        // the ledger and the failure is loud, so no record is silently lost
        // between the state file and the archive.
        this.onArchiveError?.(
          `notice archive failed for ${botId}; ${pruned.length} record(s) kept in the state file: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        bounded = all;
      }
    }
    state.notices = bounded;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      /* best effort: the files themselves are 600 */
    }
    writeFileAtomic(join(this.dir, fileName(botId)), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") {
      const fd = openSync(this.dir, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
}

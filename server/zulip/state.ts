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

import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeSync, type Stats } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

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
  // Which event queued this notice: when present, dedup matches on the key,
  // so two events whose rendered text collides still queue two notices.
  eventKey: z.string().max(200).optional().catch(undefined),
}).strict();

/** An owner DM the hourly cap refused, held for resend after the window. */
export type ZulipPendingNotice = z.infer<typeof noticeEntrySchema>;

const stateFileSchemaBase = z.object({
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
  // Loads that had to quarantine unknown top-level keys while keeping the
  // valid ledgers: a durable count, content-free, so the drift is reported
  // on the next drain instead of vanishing with the file.  (A file too
  // damaged to trust never reaches a fresh state at all - load() throws and
  // the bot stays down and loud; see below.)
  stateQuarantinedOnLoad: z.number().int().nonnegative().optional().catch(undefined),
});

/** The strict boundary: unknown top-level keys FAIL the parse, they are
 *  never silently stripped.  The lenient base above exists only so load()
 *  can tell "unknown keys alone" (salvage the valid ledgers, quarantine the
 *  drift) from real damage (quarantine the whole file). */
export const stateFileSchema = stateFileSchemaBase.strict();

/** Load-time fingerprint of the damaged state file: reconcile retries of
 *  one blocked load (byte-identical file, same mtime+size) dedup, while a
 *  genuine recurrence after repair carries a new mtime and is archived
 *  again - the recurrence stays visible in the evidence. */
export const archiveFingerprintSchema = z
  .object({ mtimeMs: z.number(), size: z.number() })
  .strict();

export type ArchiveFingerprint = z.infer<typeof archiveFingerprintSchema>;

/** One line of the notices archive, validated before the dedup read
 *  trusts its fields; a malformed line is simply not a match. */
const archiveLineSchema = z
  .object({
    archivedAt: z.number(),
    reason: z.string(),
    entry: z.unknown(),
    fingerprint: archiveFingerprintSchema.optional(),
  })
  .strict();

/** The known accounting ledgers WITHOUT their per-field catches.  The
 *  catches exist so one damaged entry does not cost the whole file, but
 *  they also silently RESET a damaged ledger (a reset dms or wakes ledger
 *  reopens hourly caps; a reset cursor skips backfill).  load() probes the
 *  raw fields with this schema instead: absent probes clean (legacy files
 *  predate the field and get the default), present-but-malformed refuses
 *  the load closed. */
const ledgerProbeSchemas = {
  cursor: z.number().int().nullable(),
  handled: z.array(z.number()),
  wakes: z.array(z.object({ at: z.number(), kind: z.enum(["owner", "peer"]), key: z.string() })),
  chains: z.record(z.string(), z.number()),
  dms: z.array(z.number()),
} as const;

/** The live state shape: exactly what stateFileSchema produces at the
 *  boundary. */
export type ZulipBotState = z.infer<typeof stateFileSchema>;

export class ZulipStateStore {
  readonly dir: string;

  private readonly onArchiveError?: (message: string) => void;

  private readonly dataRoot: string;

  constructor(dataDir: string, onArchiveError?: (message: string) => void) {
    this.onArchiveError = onArchiveError;
    this.dataRoot = dataDir;
    this.dir = join(dataDir, "zulip");
  }

  /** The saved state for this bot, or a fresh one.  A state saved for a
   *  different role (the bot was re-mapped to another Zulip identity) starts
   *  fresh: the old cursor and ring belong to someone else's mailbox.  The one
   *  exception is a rename: a file whose canonical fold is this role keeps its
   *  ledgers, relabelled, so the next save writes the canonical role. */
  load(botId: string, role: string): ZulipBotState {
    let text: string;
    let fingerprint: ArchiveFingerprint | undefined;
    const statePath = join(this.dir, fileName(botId));
    try {
      // The READ gets the same redirect policy as the writes: ancestors
      // verified, no links followed, the handle proven against the path
      // (regular, single-link, same dev+inode).  A planted link must not
      // choose which bytes become fleet accounting.  The fingerprint is
      // taken from the proven handle, so it describes the bytes loaded.
      this.verifyArchiveAncestors(statePath);
      const fd = openSync(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const handleStat = fstatSync(fd);
        const pathStat = lstatSync(statePath);
        if (
          !handleStat.isFile() ||
          !pathStat.isFile() ||
          handleStat.nlink !== 1 ||
          pathStat.nlink !== 1 ||
          handleStat.dev !== pathStat.dev ||
          handleStat.ino !== pathStat.ino
        ) {
          throw new Error(`state file ${statePath} is not a plain single-link file; refusing to load`);
        }
        fingerprint = { mtimeMs: handleStat.mtimeMs, size: handleStat.size };
        text = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      // SAFETY: filesystem failures carry .code; only a genuinely ABSENT
      // state file starts empty (a fresh bot).  A hostile or unreadable
      // path fails closed through per-bot containment - it never silently
      // resets the ledgers.
      // ENOENT splits two ways: a genuinely ABSENT tree or final file is
      // a fresh bot, but a DANGLING ancestor link (lstat sees it, realpath
      // or stat cannot resolve it) is a hostile path that must refuse
      // rather than silently reset the ledgers.
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        this.stateGenuinelyAbsent(statePath)
      ) {
        return emptyState(role);
      }
      throw error;
    }
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(text);
    } catch {
      // A state file that does not parse at all cannot be salvaged, and a
      // fresh state would silently reopen the caps and drop pending work:
      // quarantine the raw text privately, then REFUSE the load.  The
      // session constructor throws, per-bot containment keeps this bot down
      // and loud (state file untouched) while the others run, and the next
      // reconcile retries.
      try {
        this.archiveLoadIncident(botId, "state-unparseable-on-load", [text], fingerprint);
      } catch (error) {
        this.onArchiveError?.(
          `state quarantine failed for ${botId}; original file left byte-identical for retry: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        throw new Error(
          `state file for ${botId} is not parseable JSON and the quarantine archive is unwritable; original left untouched; refusing to start with empty ledgers`,
        );
      }
      throw new Error(
        `state file for ${botId} is not parseable JSON; original quarantined to the private notices archive; refusing to start with empty ledgers`,
      );
    }
    let parsed = stateFileSchema.safeParse(rawJson);
    let quarantinedUnknownKeys = false;
    if (!parsed.success) {
      // Two failure classes.  Unknown top-level keys ALONE (the lenient
      // base still parses): quarantine the unsupported fields privately and
      // KEEP every valid known ledger - pending work, notices, the DM and
      // wake caps - rather than wiping them with the file.  Anything worse
      // (a known field itself violates the schema): the whole file is
      // suspect, so quarantine it and fail closed with the counter.
      const salvaged = stateFileSchemaBase.safeParse(rawJson);
      if (salvaged.success) {
        const known = new Set<string>(stateFileSchemaBase.keyof().options);
        const unknownEntries: [string, unknown][] = [];
        // A successful base parse proves the raw value is a plain object;
        // the null/array narrowing only satisfies Object.entries' typing.
        if (rawJson !== null && rawJson !== undefined && !Array.isArray(rawJson)) {
          for (const [key, value] of Object.entries(rawJson)) {
            if (!known.has(key)) unknownEntries.push([key, value]);
          }
        }
        try {
          this.archiveLoadIncident(
            botId,
            "state-unknown-keys-on-load",
            unknownEntries.map(([key, value]) => ({ key, value })),
            fingerprint,
          );
        } catch (error) {
          // Fail closed.  Resuming with the cleaned in-memory state would
          // let the next ordinary save strip the unsupported keys from
          // disk while no durable copy exists anywhere - silent loss.  So
          // an unwritable archive refuses the load instead: the original
          // file stays byte-identical, per-bot containment keeps the bot
          // down and loud, and the next reconcile retries the quarantine.
          // The counter and repair-persist below are only reached after
          // the quarantine here has durably succeeded.
          this.onArchiveError?.(
            `unknown-key quarantine failed for ${botId}; original file left byte-identical for retry: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          throw new Error(
            `state file for ${botId} carries unsupported fields and the quarantine archive is unwritable; refusing to start so the next ordinary save cannot strip them before they are durably archived; original left untouched`,
          );
        }
        // Only now may the load repair-persist below: the drift has a
        // durable private copy, so rewriting the file loses no evidence.
        parsed = salvaged;
        quarantinedUnknownKeys = true;
      } else {
        // A known field violating the schema means the file cannot be
        // trusted: quarantine it and refuse the load rather than resuming
        // with empty caps and no pending work.  Same containment as above.
        try {
          this.archiveLoadIncident(botId, "state-schema-invalid-on-load", [rawJson], fingerprint);
        } catch (error) {
          this.onArchiveError?.(
            `state quarantine failed for ${botId}; original file left byte-identical for retry: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          throw new Error(
            `state file for ${botId} failed schema validation (a known field is malformed) and the quarantine archive is unwritable; original left untouched; refusing to start with empty ledgers`,
          );
        }
        throw new Error(
          `state file for ${botId} failed schema validation (a known field is malformed); original quarantined to the private notices archive; refusing to start with empty ledgers`,
        );
      }
    }
    // Probe the raw accounting ledgers WITHOUT their per-field catches:
    // absent is fine (legacy files get defaults), present-but-malformed is
    // real damage - a silent catch-reset would reopen the dms/wakes caps or
    // skip backfill - so it fails closed like any other trusted-field
    // violation.  pending/notices keep their designed per-entry quarantine.
    if (rawJson !== null && rawJson !== undefined && !Array.isArray(rawJson)) {
      let ledgerDamaged = false;
      for (const [key, value] of Object.entries(rawJson)) {
        switch (key) {
          case "cursor":
            ledgerDamaged ||= !ledgerProbeSchemas.cursor.safeParse(value).success;
            break;
          case "handled":
            ledgerDamaged ||= !ledgerProbeSchemas.handled.safeParse(value).success;
            break;
          case "wakes":
            ledgerDamaged ||= !ledgerProbeSchemas.wakes.safeParse(value).success;
            break;
          case "chains":
            ledgerDamaged ||= !ledgerProbeSchemas.chains.safeParse(value).success;
            break;
          case "dms":
            ledgerDamaged ||= !ledgerProbeSchemas.dms.safeParse(value).success;
            break;
        }
      }
      if (ledgerDamaged) {
        try {
          this.archiveLoadIncident(botId, "state-ledger-damaged-on-load", [rawJson], fingerprint);
        } catch (error) {
          this.onArchiveError?.(
            `state quarantine failed for ${botId}; original file left byte-identical for retry: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          throw new Error(
            `state file for ${botId} has a malformed known ledger (cursor, handled, wakes, chains or dms) and the quarantine archive is unwritable; original left untouched; refusing to start with reset ledgers`,
          );
        }
        throw new Error(
          `state file for ${botId} has a malformed known ledger (cursor, handled, wakes, chains or dms); original quarantined to the private notices archive; refusing to start with reset ledgers`,
        );
      }
    }
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
    const { userId, noticesDroppedOnLoad, pendingDroppedOnLoad, stateQuarantinedOnLoad, ...rest } = parsed.data;
    const state: ZulipBotState = { ...rest, role };
    if (userId !== undefined) state.userId = userId;
    if (stateQuarantinedOnLoad !== undefined) state.stateQuarantinedOnLoad = stateQuarantinedOnLoad;
    if (quarantinedUnknownKeys) state.stateQuarantinedOnLoad = (state.stateQuarantinedOnLoad ?? 0) + 1;
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
    if (quarantinedUnknownKeys) {
      // Repair-persist: the rewritten file carries neither the quarantined
      // keys nor a reason to quarantine them again, so the incident is
      // archived exactly once and the counter survives.  Only reached
      // after the drift quarantine above has durably succeeded; a failed
      // quarantine refused the load before this point.
      this.save(botId, state);
    }
    return state;
  }

  /** Preserve queue-cap-trimmed inbound items in the same private archive
   *  as quarantined notices: accepted input is evidence and is never
   *  destroyed without a private copy.  Throws on write failure so the
   *  caller keeps the items instead of dropping them silently. */
  archiveDroppedItems(botId: string, origin: ZulipOrigin, items: ZulipInboundItem[]): void {
    this.archive(botId, "queue-cap-item-drop", items.map((item) => ({ origin, item })));
  }

  /** O_NOFOLLOW guards only the final path component: a planted ancestor
   *  symlink would still redirect the write.  Walk every ancestor of the
   *  archive path before opening it - follow only root-owned links (the
   *  system /var -> /private/var pattern) and refuse anything else that is
   *  not a plain directory.  A missing component is skipped: mkdir just
   *  created it as a real directory, or the final handle/path inode check
   *  below still guards the file itself. */
  /** Create the state directory if missing and hold its mode at 0700
   *  through an opened, PROVEN descriptor - never chmod(2) on the path,
   *  which would follow a swapped link to its target.  Callers verify the
   *  ancestors FIRST so a planted link receives no mutation at all.  The
   *  mode repair itself is best effort: a directory the process can write
   *  but not read must not make persistence fatal. */
  private ensureStateDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const linkStat = lstatSync(this.dir);
    let followRootLink = false;
    if (linkStat.isSymbolicLink()) {
      // Mirror the ancestor policy: a root-owned link that resolves to a
      // directory is permitted (the /var -> /private/var pattern);
      // anything else refuses the write.
      if (linkStat.uid !== 0 || !statSync(this.dir).isDirectory()) {
        throw new Error(
          `state directory ${this.dir} is a symlink not owned by root or not resolving to a directory; refusing to write`,
        );
      }
      followRootLink = true;
    } else if (!linkStat.isDirectory()) {
      throw new Error(`state directory ${this.dir} is not a plain directory; refusing to write`);
    }
    let dirFd: number;
    try {
      dirFd = openSync(
        this.dir,
        followRootLink ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      // SAFETY: filesystem failures carry .code; an unreadable but
      // writable directory skips only the mode repair.
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      return;
    }
    try {
      // Prove the handle is the directory the path names right now: a
      // rename between open and fchmod must never retarget the mode
      // change.  A permitted root-owned link is proven against its
      // resolved target instead.
      const handleStat = fstatSync(dirFd);
      const pathStat = followRootLink ? statSync(this.dir) : lstatSync(this.dir);
      if (
        !handleStat.isDirectory() ||
        !pathStat.isDirectory() ||
        handleStat.dev !== pathStat.dev ||
        handleStat.ino !== pathStat.ino
      ) {
        throw new Error(`state directory ${this.dir} changed under the open; refusing to write`);
      }
      try {
        fchmodSync(dirFd, 0o700);
      } catch {
        /* best effort: the files themselves are 600 */
      }
    } finally {
      closeSync(dirFd);
    }
  }

  /** Verify, create, re-verify: the store stays self-sufficient when the
   *  configured data root does not exist yet (realpathSync needs an
   *  existing root), without mutating anything before a passed
   *  verification.  Only a MISSING root is tolerated; policy violations
   *  always refuse. */
  private verifyThenEnsureDir(path: string): void {
    try {
      this.verifyArchiveAncestors(path);
    } catch (error) {
      // SAFETY: realpathSync failures carry .code; policy violations
      // thrown by verifyArchiveAncestors are plain Errors without one.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A DANGLING root or component masquerades as ENOENT but is not
      // absence: refuse it as a policy error so the ensure below cannot
      // create through or around it.  Genuinely absent trees keep the
      // fresh-root tolerance.
      if (!this.stateGenuinelyAbsent(path)) {
        throw new Error(`state-store path ${path} sits on a dangling link; refusing to create through it`);
      }
    }
    this.ensureStateDir();
    // Re-verify UNCONDITIONALLY after creation: what exists now is what
    // the write below uses, and a planted link must receive no mutation.
    this.verifyArchiveAncestors(path);
  }

  private verifyArchiveAncestors(path: string): void {
    // The configured data root may itself be a user-owned alias (supported:
    // server/host-id.ts resolves it with realpathSync), so canonicalize the
    // root and police only the components the app creates below it.  A
    // symlink there is followed only when root-owned and resolving to a
    // directory (the /var -> /private/var pattern); anything else that is
    // not a plain directory refuses the write.  A missing component is
    // skipped: mkdir just made it, or the final handle/path inode check
    // still guards the file itself.
    const canonicalRoot = realpathSync(this.dataRoot);
    const below = relative(this.dataRoot, path);
    if (below.startsWith("..")) {
      throw new Error(`state-store write path ${path} escapes the data root; refusing`);
    }
    let current = canonicalRoot;
    for (const part of dirname(below).split(sep)) {
      if (!part || part === ".") continue;
      current = join(current, part);
      let linkStat: Stats;
      try {
        linkStat = lstatSync(current);
      } catch {
        continue;
      }
      if (linkStat.isSymbolicLink()) {
        if (linkStat.uid !== 0) {
          throw new Error(`state-store write ancestor ${current} is a symlink not owned by root; refusing to follow it`);
        }
        if (!statSync(current).isDirectory()) {
          throw new Error(`state-store write ancestor ${current} is a root-owned link that does not resolve to a directory; refusing to follow it`);
        }
      } else if (!linkStat.isDirectory()) {
        throw new Error(`state-store write ancestor ${current} is not a directory; refusing to write`);
      }
    }
  }

  /** True only when the state path is genuinely ABSENT: walking from the
   *  canonical root, some component simply does not exist (a fresh tree -
   *  save() self-creates it).  A component that lstat sees but stat cannot
   *  resolve is a DANGLING LINK: a hostile path, not absence. */
  private stateGenuinelyAbsent(statePath: string): boolean {
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(this.dataRoot);
    } catch {
      // realpath failed: walk the root's OWN components from the
      // filesystem root.  The first component lstat cannot see is genuine
      // absence (a fresh tree, from there down); a component lstat sees
      // but stat cannot resolve is a DANGLING LINK at or above the root -
      // hostile, not absence.  Anything else (EACCES, ELOOP) refuses too.
      let current: string = sep;
      // resolve() anchors a RELATIVE configured root at the process cwd:
      // the walk must inspect the path the store actually uses, not a
      // same-named tree under the filesystem root.
      for (const part of resolve(this.dataRoot).split(sep)) {
        if (!part) continue;
        current = join(current, part);
        let linkStat: Stats;
        try {
          linkStat = lstatSync(current);
        } catch (error) {
          // SAFETY: lstatSync failures carry .code; a missing component is
          // genuine absence, anything else (EACCES, ELOOP) is not.
          return (error as NodeJS.ErrnoException).code === "ENOENT";
        }
        if (linkStat.isSymbolicLink()) {
          try {
            statSync(current);
          } catch {
            return false;
          }
        }
      }
      // Every component lstat-visible yet realpath failed (a link loop):
      // refuse (safe side).
      return false;
    }
    const below = relative(this.dataRoot, statePath);
    if (below.startsWith("..")) return false;
    let current = canonicalRoot;
    for (const part of below.split(sep)) {
      if (!part || part === ".") continue;
      current = join(current, part);
      let linkStat: Stats;
      try {
        linkStat = lstatSync(current);
      } catch (error) {
        // SAFETY: lstatSync failures carry .code; a missing component is
        // genuine absence, anything else (EACCES, ELOOP) is not.
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
      if (linkStat.isSymbolicLink()) {
        try {
          statSync(current);
        } catch {
          // A link that does not resolve is dangling: hostile, not absent.
          return false;
        }
      }
    }
    // Every component exists for lstat and resolves: the ENOENT came from
    // a race after verification, not from absence.  Refuse (safe side).
    return false;
  }

  /** Load-quarantine wrapper.  A bot blocked by a damaged state file
   *  fails the same way every reconcile, and appending an identical copy
   *  each cycle grows the append-only archive without adding evidence.
   *  Skip the append when the archive's retained tail already carries
   *  this incident's complete entry sequence in order - one load can
   *  emit several incidents (drift AND ledger damage), so this one is
   *  not necessarily the final line, and a multi-entry incident spans
   *  several lines.  A miss appends: a duplicate is evidence, never
   *  loss. */
  private archiveLoadIncident(botId: string, reason: string, entries: unknown[], fingerprint?: ArchiveFingerprint): void {
    const path = join(this.dir, fileName(botId).replace(/\.json$/, ".notices-archive.jsonl"));
    try {
      // The dedup read is part of the durability claim, so it gets the
      // same protections as the write: ancestors verified, no links
      // followed, the handle proven against the path.  A planted link
      // faking a matching tail must never read as "already archived";
      // any failure falls through to archive(), whose own verification
      // refuses the write and fails the load closed.
      this.verifyArchiveAncestors(path);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const handleStat = fstatSync(fd);
        const pathStat = lstatSync(path);
        if (
          !handleStat.isFile() ||
          !pathStat.isFile() ||
          handleStat.dev !== pathStat.dev ||
          handleStat.ino !== pathStat.ino
        ) {
          throw new Error("archive tail is not a plain file");
        }
        const size = Math.min(handleStat.size, 256 * 1024);
        const buffer = Buffer.alloc(size);
        readSync(fd, buffer, 0, size, handleStat.size - size);
        const lines = buffer.toString("utf8").trimEnd().split("\n");
        for (let start = lines.length - entries.length; start >= 0; start -= 1) {
          let match = true;
          for (let index = 0; index < entries.length; index += 1) {
            let line: unknown;
            try {
              line = JSON.parse(lines[start + index]);
            } catch {
              match = false;
              break;
            }
            const candidate = archiveLineSchema.safeParse(line);
            if (
              !candidate.success ||
              candidate.data.reason !== reason ||
              JSON.stringify(candidate.data.entry) !== JSON.stringify(entries[index]) ||
              JSON.stringify(candidate.data.fingerprint ?? null) !== JSON.stringify(fingerprint ?? null)
            ) {
              match = false;
              break;
            }
          }
          if (match) return;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // No readable or verifiable archive yet: append normally (or, when
      // the path itself is hostile, archive() below throws and the load
      // fails closed).
    }
    this.archive(botId, reason, entries, fingerprint);
  }

  /** Append records to the bot's private notices archive (mode-600 JSONL
   *  next to the state file): the evidence for anything the ledger no
   *  longer carries.  Contents are never logged or posted. */
  private archive(botId: string, reason: string, entries: unknown[], fingerprint?: ArchiveFingerprint): void {
    if (entries.length === 0) return;
    const path = join(this.dir, fileName(botId).replace(/\.json$/, ".notices-archive.jsonl"));
    // Ancestors first, BEFORE any mutation: a planted link in the path
    // above the file redirects the write even with O_NOFOLLOW on the final
    // component, and it must not even have its target created or
    // re-permissioned.
    this.verifyThenEnsureDir(path);
    const archivedAt = Date.now();
    const lines =
      entries
        .map((entry) =>
          JSON.stringify(
            fingerprint === undefined
              ? { archivedAt, reason, entry }
              : { archivedAt, reason, entry, fingerprint },
          ),
        )
        .join("\n") + "\n";
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
      // Re-verify the ancestors now that the handle exists.  This narrows
      // the check/open race but cannot close it: Node's fs exposes no
      // descriptor-relative (openat-style) traversal, so a swapped ancestor
      // between the two passes still resolves.  The residual window is
      // documented, not hidden.
      this.verifyArchiveAncestors(path);
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
      // Mode through the verified descriptor: chmod(2) on the path would
      // follow a swapped link to its target.
      try {
        fchmodSync(fd, 0o600);
      } catch {
        // best effort
      }
    } finally {
      closeSync(fd);
    }
  }

  save(botId: string, state: ZulipBotState, now = Date.now()): void {
    // The state file gets the same redirect policy as the archive, and the
    // check comes BEFORE any mutation: a planted ancestor link must not
    // even have its target created or re-permissioned.  A violation
    // throws - session.save logs it and the in-memory ledgers survive to
    // retry.
    this.verifyThenEnsureDir(join(this.dir, fileName(botId)));
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
    writeFileAtomic(join(this.dir, fileName(botId)), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") {
      try {
        const fd = openSync(this.dir, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } catch (error) {
        // SAFETY: filesystem failures carry .code.  The directory fsync is
        // a durability extra; an unreadable directory still holds the
        // renamed file, so it must not fail the save.
        if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      }
    }
  }
}

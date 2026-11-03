import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import { HOST_ID_PATTERN, type HostId, type Lease } from "../shared/placement.ts";
import { writeFileAtomic } from "./atomic.ts";
import { loadControllerEpoch, openControllerEpochStore, type ControllerEpochStore } from "./placement-identity.ts";
import { JOB_RECORD_MAX } from "../shared/jobs.ts";

const host = z.string().regex(HOST_ID_PATTERN).transform((value) => {
  // SAFETY: the regex checks exactly the HostId wire shape.
  return value as HostId;
});
const epoch = z.number().int().nonnegative().safe();
const controllerSchema = z.object({ controllerId: host, epoch }).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reportSchema = z.object({
  status: z.enum(["completed", "failed", "killed", "lost"]), exitCode: z.number().int().nullable(),
  signal: z.string().nullable(), endedAt: z.number().finite(), reason: z.string().optional(),
}).strict();
const jobSchema = z.object({
  jobId: z.string().min(1), botId: z.string().min(1), threadId: z.string().min(1),
  cwd: z.string().min(1), timeoutMs: z.number().positive().finite(), payloadDigest: digest,
  fingerprint: digest, queuedAt: z.number().finite(),
  status: z.enum(["queued", "dispatching", "running", "worker-unreachable", "completed", "failed", "killed", "lost"]),
  host: host.optional(), leaseId: z.string().min(1).optional(), requiredReason: z.string().optional(),
  queuedReason: z.string().optional(), placedReason: z.string().optional(), stopReason: z.string().optional(),
  ranAfterTakeover: z.boolean().optional(), report: reportSchema.optional(), hidden: z.boolean().optional(),
  queueExpiry: z.object({ deadlineAt: z.number().finite(), expiredAt: z.number().finite() }).strict().optional(),
}).strict();
const leaseSchema = z.object({
  controllerId: host, epoch, leaseId: z.string().min(1), jobId: z.string().min(1), host,
  state: z.enum(["active", "released", "settled"]),
  // A future worker-revocation unit owns validation of this durable receipt.
  revocationId: z.string().min(1).optional(),
}).strict();
const stateSchema = z.object({
  controller: controllerSchema, reconcile: z.boolean(), jobs: z.array(jobSchema), leases: z.array(leaseSchema),
  pendingStops: z.array(z.object({ hostId: host, leaseId: z.string().min(1) }).strict()),
}).strict();
const markerSchema = z.object({
  format: z.literal("botfleet-placement-sqlite"), version: z.literal(1), migrationId: z.uuid(),
}).strict();
const metaSchema = z.object({
  version: z.literal(1), storage: z.literal("normalized-v1"), migrationId: z.uuid(), phase: z.enum(["prepared", "active"]), initialController: controllerSchema,
}).strict();
const headerSchema = z.object({ controller: controllerSchema, reconcile: z.boolean() }).strict();

export type StoredPlacementJob = z.infer<typeof jobSchema>;
export type StoredPlacementLease = z.infer<typeof leaseSchema>;
export type PlacementState = z.infer<typeof stateSchema>;
type MigrationMeta = z.infer<typeof metaSchema>;
const TERMINAL = new Set(["completed", "failed", "killed", "lost"]);
export const PLACEMENT_ACTIVE_LIMIT = JOB_RECORD_MAX;
// Reuses the existing finished-job frame display convention, not a resource budget.
export const PLACEMENT_RECENT_LIMIT = 20;
export const PLACEMENT_QUEUE_EXPIRED_REASON = "The background job queue wait window expired";

export class PlacementStoreError extends Error {
  constructor() { super("Placement persistence is unavailable; preserve the store and restore its verified state"); }
}

export function commandDigest(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}
export function placementFingerprint(job: Pick<StoredPlacementJob, "jobId" | "botId" | "threadId" | "cwd" | "timeoutMs" | "payloadDigest">): string {
  return createHash("sha256").update(JSON.stringify([
    job.jobId, job.botId, job.threadId, job.cwd, job.timeoutMs, job.payloadDigest,
  ])).digest("hex");
}

function validateState(state: PlacementState): void {
  const jobs = new Map(state.jobs.map((job) => [job.jobId, job]));
  const leases = new Map(state.leases.map((lease) => [lease.leaseId, lease]));
  if (jobs.size !== state.jobs.length || leases.size !== state.leases.length) throw new PlacementStoreError();
  if (state.jobs.filter((job) => !TERMINAL.has(job.status)).length > PLACEMENT_ACTIVE_LIMIT) throw new PlacementStoreError();
  for (const job of jobs.values()) {
    if (job.fingerprint !== placementFingerprint(job)) throw new PlacementStoreError();
    if (job.hidden && !TERMINAL.has(job.status)) throw new PlacementStoreError();
    if (job.queueExpiry) {
      if (job.status !== "lost" || job.host !== undefined || job.leaseId !== undefined || !job.report
        || job.report.status !== "lost" || job.report.exitCode !== null || job.report.signal !== null
        || job.report.endedAt !== job.queueExpiry.expiredAt || job.report.reason !== PLACEMENT_QUEUE_EXPIRED_REASON
        || job.queueExpiry.deadlineAt <= job.queuedAt || job.queueExpiry.expiredAt < job.queueExpiry.deadlineAt) throw new PlacementStoreError();
    } else if (job.status === "queued") {
      if (job.host !== undefined || job.leaseId !== undefined || job.report !== undefined) throw new PlacementStoreError();
    } else {
      const lease = job.leaseId ? leases.get(job.leaseId) : undefined;
      if (!lease || lease.jobId !== job.jobId || lease.host !== job.host || lease.state !== (TERMINAL.has(job.status) ? "settled" : "active")) throw new PlacementStoreError();
      if (TERMINAL.has(job.status) && job.report?.status !== job.status) throw new PlacementStoreError();
    }
  }
  for (const lease of leases.values()) {
    const job = jobs.get(lease.jobId);
    if (!job || lease.epoch > state.controller.epoch || (lease.epoch === state.controller.epoch && lease.controllerId !== state.controller.controllerId)) throw new PlacementStoreError();
    if (lease.state !== "released" && lease.revocationId !== undefined) throw new PlacementStoreError();
    if (lease.state === "released") {
      if (!lease.revocationId || job.leaseId === lease.leaseId) throw new PlacementStoreError();
    } else if (job.leaseId !== lease.leaseId || job.host !== lease.host) throw new PlacementStoreError();
  }
  const stops = new Set<string>();
  for (const stop of state.pendingStops) {
    const lease = leases.get(stop.leaseId);
    if (!lease || lease.host !== stop.hostId || lease.state !== "active" || stops.has(stop.leaseId)) throw new PlacementStoreError();
    stops.add(stop.leaseId);
  }
}

function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function privateFile(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== "win32" && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()))) throw new PlacementStoreError();
  return stat;
}
function readPrivateJson(path: string): z.infer<typeof markerSchema> | z.infer<typeof controllerSchema> {
  const before = privateFile(path);
  if (before.size > 4096) throw new PlacementStoreError();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameInode(before, fstatSync(fd))) throw new PlacementStoreError();
    const json: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!sameInode(before, lstatSync(path))) throw new PlacementStoreError();
    return z.union([markerSchema, controllerSchema]).parse(json);
  } finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    // SAFETY: node:fs exceptions carry an optional string error code.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function checkSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm"]) {
    try { privateFile(`${path}${suffix}`); }
    catch (error) {
      // SAFETY: a sidecar can disappear when another SQLite connection closes.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export interface PlacementStore {
  readonly path: string;
  /** Offline compatibility export for fixtures/audits; never recurring service work. */
  read(): PlacementState;
  readAll(): PlacementState;
  readScope(scope?: PlacementScope): PlacementState;
  /** Offline complete-ledger editor for fixtures/audits only. */
  transaction<T>(change: (state: PlacementState) => T): T;
  transactionScope<T>(scope: PlacementScope, change: (state: PlacementState) => T): T;
  metrics(): PlacementStoreMetrics;
  resetMetrics(): void;
  close(): void;
}
export interface PlacementScope {
  active?: boolean;
  recent?: boolean;
  jobIds?: readonly string[];
  leaseIds?: readonly string[];
}
export interface PlacementStoreMetrics { queries: number; rowsRead: number; rowsWritten: number }

const SQL_SCHEMA = `
  CREATE TABLE placement_meta (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
  CREATE TABLE placement_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
  CREATE TABLE placement_jobs (
    job_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN(0,1)),
    hidden INTEGER NOT NULL CHECK(hidden IN(0,1)), queued_at REAL NOT NULL, finished_at REAL,
    current_lease_id TEXT UNIQUE REFERENCES placement_leases(lease_id) DEFERRABLE INITIALLY DEFERRED,
    json TEXT NOT NULL
  );
  CREATE INDEX placement_jobs_active ON placement_jobs(active,job_id);
  CREATE INDEX placement_jobs_recent ON placement_jobs(active,hidden,finished_at DESC,job_id DESC);
  CREATE TABLE placement_leases (
    lease_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES placement_jobs(job_id) DEFERRABLE INITIALLY DEFERRED,
    host TEXT NOT NULL, controller_id TEXT NOT NULL, epoch INTEGER NOT NULL
  );
  CREATE INDEX placement_leases_job ON placement_leases(job_id);
  CREATE TABLE placement_lease_tombstones (
    lease_id TEXT PRIMARY KEY REFERENCES placement_leases(lease_id),
    state TEXT NOT NULL CHECK(state IN('released','settled')), revocation_id TEXT,
    CHECK((state='released' AND revocation_id IS NOT NULL) OR (state='settled' AND revocation_id IS NULL))
  );
  CREATE TABLE placement_pending_stops (
    lease_id TEXT PRIMARY KEY REFERENCES placement_leases(lease_id), host_id TEXT NOT NULL
  );
  CREATE TRIGGER placement_jobs_no_delete BEFORE DELETE ON placement_jobs BEGIN SELECT RAISE(FAIL,'permanent job fence'); END;
  CREATE TRIGGER placement_leases_no_delete BEFORE DELETE ON placement_leases BEGIN SELECT RAISE(FAIL,'permanent lease fence'); END;
  CREATE TRIGGER placement_leases_no_update BEFORE UPDATE ON placement_leases BEGIN SELECT RAISE(FAIL,'immutable issuing lease'); END;
  CREATE TRIGGER placement_tombstones_no_delete BEFORE DELETE ON placement_lease_tombstones BEGIN SELECT RAISE(FAIL,'permanent tombstone'); END;
  CREATE TRIGGER placement_tombstones_no_update BEFORE UPDATE ON placement_lease_tombstones BEGIN SELECT RAISE(FAIL,'immutable tombstone'); END;
  CREATE TRIGGER placement_active_insert BEFORE INSERT ON placement_jobs WHEN NEW.active=1 AND
    (SELECT count(*) FROM placement_jobs WHERE active=1)>=${PLACEMENT_ACTIVE_LIMIT}
    BEGIN SELECT RAISE(FAIL,'unresolved placement capacity'); END;
  CREATE TRIGGER placement_active_update BEFORE UPDATE ON placement_jobs WHEN OLD.active=0 AND NEW.active=1 AND
    (SELECT count(*) FROM placement_jobs WHERE active=1)>=${PLACEMENT_ACTIVE_LIMIT}
    BEGIN SELECT RAISE(FAIL,'unresolved placement capacity'); END;
`;
type SqlRow = Record<string, SQLOutputValue>;

export type PlacementAuthority =
  | { kind: "legacy"; controllerStore: ControllerEpochStore }
  | { kind: "sqlite"; store: PlacementStore };

/** Ordinary updates retain the epoch-aware JSON rollback contract.
 * Only a prior verified activation's UUID marker selects SQLite in production. */
export function openPlacementAuthority(dataDir: string, hostId: HostId, platform: NodeJS.Platform = process.platform): PlacementAuthority {
  const path = join(dataDir, "placement-controller.json");
  if (exists(path)) {
    const value = readPrivateJson(path);
    if (markerSchema.safeParse(value).success) return { kind: "sqlite", store: openPlacementStore(dataDir, hostId, platform) };
  }
  // An unexplained database cannot become a second ignored authority.
  if (exists(join(dataDir, "placement.sqlite"))) throw new PlacementStoreError();
  return { kind: "legacy", controllerStore: openControllerEpochStore(dataDir, hostId) };
}

/** Requires the harness ownership fence before production migration.
 * SQLite owns all live placement state; the strict JSON becomes only a UUID marker.
 * The injected platform can only add a refusal, never enable an unsupported runtime. */
export function openPlacementStore(dataDir: string, hostId: HostId, platform: NodeJS.Platform = process.platform): PlacementStore {
  // No unsupported host may create/open SQLite or replace the rollback marker.
  if ((process.platform !== "darwin" && process.platform !== "linux") ||
      (platform !== "darwin" && platform !== "linux")) throw new PlacementStoreError();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dir = realpathSync(dataDir);
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0) throw new PlacementStoreError();
  const path = join(dir, "placement.sqlite");
  const legacyPath = join(dir, "placement-controller.json");
  const lock = join(dir, "placement-controller.lock");
  // Only a genuinely empty first start may initialize epoch zero.
  if (!exists(legacyPath)) {
    if (exists(path)) throw new PlacementStoreError();
    loadControllerEpoch(dir, hostId);
  }
  mkdirSync(lock, { mode: 0o700 });
  let db: DatabaseSync | undefined;
  let migrationId: string;
  try {
    const legacy: unknown = readPrivateJson(legacyPath);
    const marker = markerSchema.safeParse(legacy);
    const controller = controllerSchema.safeParse(legacy);
    if (!marker.success && !controller.success) throw new PlacementStoreError();
    const present = exists(path);
    if (marker.success && !present) throw new PlacementStoreError();
    if (!present) closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    privateFile(path);
    checkSidecars(path);
    db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON");
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal" || db.prepare("PRAGMA synchronous").get()?.synchronous !== 2) throw new PlacementStoreError();
    if (!present) {
      if (!controller.success) throw new PlacementStoreError();
      const meta: MigrationMeta = { version: 1, storage: "normalized-v1", migrationId: randomUUID(), phase: "prepared", initialController: controller.data };
      const state = { controller: controller.data, reconcile: false };
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(SQL_SCHEMA);
        db.exec("PRAGMA user_version = 1");
        db.prepare("INSERT INTO placement_meta VALUES (1, ?)").run(JSON.stringify(meta));
        db.prepare("INSERT INTO placement_state VALUES (1, ?)").run(JSON.stringify(state));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      syncDirectory(dir);
    }
    if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) throw new PlacementStoreError();
    const meta = metaSchema.parse(JSON.parse(String(db.prepare("SELECT json FROM placement_meta WHERE id = 1").get()?.json)));
    const state = headerSchema.parse(JSON.parse(String(db.prepare("SELECT json FROM placement_state WHERE id = 1").get()?.json)));
    if (state.controller.epoch < meta.initialController.epoch || (state.controller.epoch === meta.initialController.epoch && state.controller.controllerId !== meta.initialController.controllerId)) throw new PlacementStoreError();
    const hasHistory = meta.phase === "prepared" && (db.prepare("SELECT 1 AS present FROM placement_jobs LIMIT 1").get()
      || db.prepare("SELECT 1 AS present FROM placement_leases LIMIT 1").get() || db.prepare("SELECT 1 AS present FROM placement_pending_stops LIMIT 1").get());
    if (meta.phase === "prepared" && (JSON.stringify(state.controller) !== JSON.stringify(meta.initialController) || hasHistory || state.reconcile)) throw new PlacementStoreError();
    if (marker.success) {
      if (marker.data.migrationId !== meta.migrationId) throw new PlacementStoreError();
    } else {
      if (!controller.success || meta.phase !== "prepared" || JSON.stringify(meta.initialController) !== JSON.stringify(controller.data)
        || JSON.stringify(state.controller) !== JSON.stringify(controller.data) || hasHistory || state.reconcile) throw new PlacementStoreError();
      writeFileAtomic(legacyPath, `${JSON.stringify({ format: "botfleet-placement-sqlite", version: 1, migrationId: meta.migrationId })}\n`, { mode: 0o600, exactMode: true });
    }
    // Visibility after a prior rename/crash does not prove its directory barrier.
    // Repeat for verified recovered and active markers before activation or use.
    syncDirectory(dir);
    if (meta.phase === "prepared") {
      db.exec("BEGIN IMMEDIATE");
      try {
        meta.phase = "active";
        db.prepare("UPDATE placement_meta SET json = ? WHERE id = 1").run(JSON.stringify(meta));
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
    checkSidecars(path);
    migrationId = meta.migrationId;
  } catch (error) {
    db?.close();
    throw error instanceof PlacementStoreError ? error : new PlacementStoreError();
  } finally { rmdirSync(lock); }
  if (!db) throw new PlacementStoreError();
  const database = db;
  const inode = privateFile(path);
  let observed = headerSchema.parse(JSON.parse(String(database.prepare("SELECT json FROM placement_state WHERE id = 1").get()?.json))).controller;
  let closed = false;
  let inTransaction = false;
  const counters: PlacementStoreMetrics = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  function get(sql: string, args: SQLInputValue[] = []): SqlRow | undefined {
    counters.queries++;
    const row = database.prepare(sql).get(...args);
    if (row) counters.rowsRead++;
    return row;
  }
  function all(sql: string, args: SQLInputValue[] = []): SqlRow[] {
    counters.queries++;
    const rows = database.prepare(sql).all(...args);
    counters.rowsRead += rows.length;
    return rows;
  }
  function run(sql: string, args: SQLInputValue[] = []): void {
    counters.queries++;
    counters.rowsWritten += Number(database.prepare(sql).run(...args).changes);
  }
  function checkFiles(): void {
    const currentDirectory = lstatSync(dir);
    if (closed || !sameInode(directory, currentDirectory) || currentDirectory.uid !== process.getuid?.() || (currentDirectory.mode & 0o022) !== 0
      || !sameInode(inode, privateFile(path))) throw new PlacementStoreError();
    checkSidecars(path);
    const marker = markerSchema.parse(readPrivateJson(legacyPath));
    if (marker.migrationId !== migrationId) throw new PlacementStoreError();
  }
  function checkBinding(): void {
    checkFiles();
    if (get("PRAGMA user_version")?.user_version !== 1) throw new PlacementStoreError();
    const meta = metaSchema.parse(JSON.parse(String(get("SELECT json FROM placement_meta WHERE id = 1")?.json)));
    if (meta.migrationId !== migrationId || meta.phase !== "active") throw new PlacementStoreError();
  }
  const leaseSelect = `SELECT l.lease_id,l.job_id,l.host,l.controller_id,l.epoch,t.state AS tombstone_state,t.revocation_id
    FROM placement_leases l LEFT JOIN placement_lease_tombstones t ON t.lease_id=l.lease_id`;
  function decodeJob(row: SqlRow): StoredPlacementJob {
    const job = jobSchema.parse(JSON.parse(String(row.json)));
    if (row.job_id !== job.jobId || row.fingerprint !== job.fingerprint || row.active !== (TERMINAL.has(job.status) ? 0 : 1)
      || row.hidden !== (job.hidden ? 1 : 0) || row.queued_at !== job.queuedAt || row.finished_at !== (job.report?.endedAt ?? null)
      || row.current_lease_id !== (job.leaseId ?? null)) throw new PlacementStoreError();
    return job;
  }
  function decodeLease(row: SqlRow): StoredPlacementLease {
    return leaseSchema.parse({
      controllerId: row.controller_id, epoch: row.epoch, leaseId: row.lease_id,
      jobId: row.job_id, host: row.host, state: row.tombstone_state ?? "active",
      revocationId: row.revocation_id ?? undefined,
    });
  }
  function placeholders(ids: readonly string[]): string { return ids.map(() => "?").join(","); }
  function load(scope: PlacementScope, complete = false): PlacementState {
    if ((scope.jobIds?.length ?? 0) > JOB_RECORD_MAX || (scope.leaseIds?.length ?? 0) > JOB_RECORD_MAX) throw new PlacementStoreError();
    const header = headerSchema.parse(JSON.parse(String(get("SELECT json FROM placement_state WHERE id = 1")?.json)));
    if (header.controller.epoch < observed.epoch || (header.controller.epoch === observed.epoch && header.controller.controllerId !== observed.controllerId)) throw new PlacementStoreError();
    observed = { ...header.controller };
    const jobs = new Map<string, StoredPlacementJob>();
    const leases = new Map<string, StoredPlacementLease>();
    function addJobs(rows: SqlRow[]): void { for (const row of rows) { const job = decodeJob(row); jobs.set(job.jobId, job); } }
    function addLeases(rows: SqlRow[]): void { for (const row of rows) { const lease = decodeLease(row); leases.set(lease.leaseId, lease); } }
    if (complete) {
      addJobs(all("SELECT * FROM placement_jobs ORDER BY queued_at,job_id"));
      addLeases(all(`${leaseSelect} ORDER BY l.rowid`));
    } else {
      if (scope.active) addJobs(all("SELECT * FROM placement_jobs WHERE active=1 ORDER BY job_id LIMIT ?", [PLACEMENT_ACTIVE_LIMIT + 1]));
      if (scope.recent) addJobs(all("SELECT * FROM placement_jobs WHERE active=0 AND hidden=0 ORDER BY finished_at DESC,job_id DESC LIMIT ?", [PLACEMENT_RECENT_LIMIT]));
      const requestedJobs = [...new Set(scope.jobIds ?? [])].filter((id) => !jobs.has(id));
      if (requestedJobs.length) addJobs(all(`SELECT * FROM placement_jobs WHERE job_id IN (${placeholders(requestedJobs)})`, requestedJobs));
      for (let round = 0; round < 2; round++) {
        const ids = new Set(scope.leaseIds ?? []);
        for (const job of jobs.values()) if (job.leaseId) ids.add(job.leaseId);
        const missingLeases = [...ids].filter((id) => !leases.has(id));
        if (missingLeases.length) addLeases(all(`${leaseSelect} WHERE l.lease_id IN (${placeholders(missingLeases)})`, missingLeases));
        const missingJobs = [...new Set([...leases.values()].map((lease) => lease.jobId))].filter((id) => !jobs.has(id));
        if (missingJobs.length) addJobs(all(`SELECT * FROM placement_jobs WHERE job_id IN (${placeholders(missingJobs)})`, missingJobs));
      }
    }
    const ids = [...leases.keys()];
    const stopRows = complete ? all("SELECT * FROM placement_pending_stops ORDER BY lease_id") :
      ids.length ? all(`SELECT * FROM placement_pending_stops WHERE lease_id IN (${placeholders(ids)}) ORDER BY lease_id`, ids) : [];
    const state: PlacementState = {
      ...header, jobs: [...jobs.values()], leases: [...leases.values()],
      pendingStops: stopRows.map((row) => ({
        hostId: host.parse(row.host_id), leaseId: String(row.lease_id),
      })),
    };
    stateSchema.parse(state);
    validateState(state);
    return state;
  }
  function persist(previous: PlacementState, state: PlacementState): void {
    stateSchema.parse(state);
    validateState(state);
    const jobs = new Map(state.jobs.map((job) => [job.jobId, job]));
    const leases = new Map(state.leases.map((lease) => [lease.leaseId, lease]));
    const oldJobs = new Map(previous.jobs.map((job) => [job.jobId, job]));
    const oldLeases = new Map(previous.leases.map((lease) => [lease.leaseId, lease]));
    if (state.controller.epoch < previous.controller.epoch || (state.controller.epoch === previous.controller.epoch && state.controller.controllerId !== previous.controller.controllerId)) throw new PlacementStoreError();
    for (const old of previous.jobs) {
      const next = jobs.get(old.jobId);
      if (!next || next.fingerprint !== old.fingerprint || next.queuedAt !== old.queuedAt
        || (old.report !== undefined && (next.status !== old.status || JSON.stringify(next.report) !== JSON.stringify(old.report)))) throw new PlacementStoreError();
    }
    for (const old of previous.leases) {
      const next = leases.get(old.leaseId);
      if (!next || next.jobId !== old.jobId || next.host !== old.host || next.controllerId !== old.controllerId || next.epoch !== old.epoch
        || (old.state !== "active" && JSON.stringify(old) !== JSON.stringify(next))) throw new PlacementStoreError();
    }
    if (state.controller.epoch > previous.controller.epoch) {
      for (const job of state.jobs) {
        const lease = job.leaseId ? leases.get(job.leaseId) : undefined;
        if (!TERMINAL.has(job.status) && lease && lease.epoch < state.controller.epoch && !job.ranAfterTakeover) throw new PlacementStoreError();
      }
    }
    for (const job of jobs.values()) {
      const old = oldJobs.get(job.jobId);
      if (job.queueExpiry && !old?.queueExpiry && (!old || old.status !== "queued" || old.host !== undefined || old.leaseId !== undefined)) throw new PlacementStoreError();
      if (old?.queueExpiry && JSON.stringify(old.queueExpiry) !== JSON.stringify(job.queueExpiry)) throw new PlacementStoreError();
      if (old && JSON.stringify(old) === JSON.stringify(job)) continue;
      const columns: SQLInputValue[] = [TERMINAL.has(job.status) ? 0 : 1, job.hidden ? 1 : 0, job.queuedAt, job.report?.endedAt ?? null, job.leaseId ?? null, JSON.stringify(job)];
      if (old) run("UPDATE placement_jobs SET active=?,hidden=?,queued_at=?,finished_at=?,current_lease_id=?,json=? WHERE job_id=?", [...columns, job.jobId]);
      else run("INSERT INTO placement_jobs(job_id,fingerprint,active,hidden,queued_at,finished_at,current_lease_id,json) VALUES(?,?,?,?,?,?,?,?)", [job.jobId, job.fingerprint, ...columns]);
    }
    for (const lease of leases.values()) {
      const old = oldLeases.get(lease.leaseId);
      if (!old) run("INSERT INTO placement_leases(lease_id,job_id,host,controller_id,epoch) VALUES(?,?,?,?,?)", [lease.leaseId, lease.jobId, lease.host, lease.controllerId, lease.epoch]);
      if (lease.state !== "active" && (!old || old.state === "active")) {
        run("INSERT INTO placement_lease_tombstones(lease_id,state,revocation_id) VALUES(?,?,?)", [lease.leaseId, lease.state, lease.revocationId ?? null]);
      }
    }
    const stops = new Map(state.pendingStops.map((stop) => [stop.leaseId, stop]));
    const oldStops = new Map(previous.pendingStops.map((stop) => [stop.leaseId, stop]));
    for (const id of oldStops.keys()) if (!stops.has(id)) run("DELETE FROM placement_pending_stops WHERE lease_id=?", [id]);
    for (const [id, stop] of stops) if (!oldStops.has(id)) run("INSERT INTO placement_pending_stops(lease_id,host_id) VALUES(?,?)", [id, stop.hostId]);
    const header = JSON.stringify({ controller: state.controller, reconcile: state.reconcile });
    if (header !== JSON.stringify({ controller: previous.controller, reconcile: previous.reconcile })) run("UPDATE placement_state SET json=? WHERE id=1", [header]);
  }
  function readScope(scope: PlacementScope = {}, complete = false): PlacementState {
    if (inTransaction) throw new PlacementStoreError();
    checkFiles();
    database.exec("BEGIN");
    inTransaction = true;
    try {
      checkBinding();
      const state = load(scope, complete);
      database.exec("COMMIT");
      return state;
    } catch {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the original refusal. */ }
      throw new PlacementStoreError();
    } finally { inTransaction = false; }
  }
  function transactionScope<T>(scope: PlacementScope, change: (state: PlacementState) => T, complete = false): T {
    if (inTransaction) throw new PlacementStoreError();
    checkFiles();
    database.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    try {
      checkBinding();
      const state = load(scope, complete);
      const previous = structuredClone(state);
      const result = change(state);
      if (!complete && !scope.active && JSON.stringify({ controller: state.controller, reconcile: state.reconcile })
        !== JSON.stringify({ controller: previous.controller, reconcile: previous.reconcile })) throw new PlacementStoreError();
      persist(previous, state);
      checkBinding();
      database.exec("COMMIT");
      checkSidecars(path);
      observed = { ...state.controller };
      return result;
    } catch {
      try { database.exec("ROLLBACK"); } catch { /* A failed commit may have ended the transaction. */ }
      throw new PlacementStoreError();
    } finally { inTransaction = false; }
  }
  function readAll(): PlacementState { return readScope({}, true); }
  return {
    path, read: readAll, readAll, readScope,
    transaction: (change) => transactionScope({}, change, true),
    transactionScope,
    metrics: () => ({ ...counters }),
    resetMetrics() { counters.queries = 0; counters.rowsRead = 0; counters.rowsWritten = 0; },
    close() { if (!closed) { database.close(); closed = true; } },
  };
}

export function issuedLease(lease: StoredPlacementLease): Lease {
  return { controllerId: lease.controllerId, epoch: lease.epoch, leaseId: lease.leaseId, jobId: lease.jobId, host: lease.host };
}

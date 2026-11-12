// Private restart recovery for accepted local waiters.
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";

export const PENDING_COMMAND_MAX_CHARS = 16_000;
// JSON escaping takes at most six bytes per accepted UTF-16 code unit.
export const PENDING_PAYLOAD_MAX_BYTES = PENDING_COMMAND_MAX_CHARS * 6 + 1024;
const JOB_ID = /^job_[0-9A-Za-z]{10,40}$/;
const FAILURE = "Private pending command storage is unavailable";

export interface PendingIdentity {
  id: string;
  botId: string;
  threadId: string;
  turnId?: string;
  origin: string;
  cwd: string;
  startedAt: number;
  timeoutMs: number;
  controllerHostId?: string;
  host?: string;
}

function binding(job: PendingIdentity): string {
  return createHash("sha256").update(JSON.stringify([
    job.id, job.botId, job.threadId, job.turnId ?? null, job.origin, job.cwd,
    job.startedAt, job.timeoutMs, job.controllerHostId ?? null, job.host ?? null,
  ])).digest("hex");
}
function sameInode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function owned(stat: Stats): boolean { return process.getuid !== undefined && stat.uid === process.getuid(); }

export class PendingCommandSpool {
  private readonly path: string;
  private readonly inode: Stats;
  private readonly parentPath: string;
  private readonly parentInode: Stats;
  private readonly maxCount: number;

  constructor(jobsDir: string, maxCount: number) {
    this.maxCount = maxCount;
    try {
      const parent = lstatSync(jobsDir);
      if (!parent.isDirectory() || !owned(parent) || (parent.mode & 0o022) !== 0) throw new Error();
      this.parentPath = realpathSync(jobsDir);
      this.parentInode = parent;
      this.path = join(this.parentPath, "pending-commands");
      try { mkdirSync(this.path, { mode: 0o700 }); }
      catch (error) {
        // SAFETY: synchronous Node filesystem errors carry an optional errno code; no other field is assumed.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      this.inode = lstatSync(this.path);
      this.checkDirectory();
    } catch { throw new Error(FAILURE); }
  }

  private checkDirectory(): void {
    const parent = lstatSync(this.parentPath);
    if (!parent.isDirectory() || !owned(parent) || (parent.mode & 0o022) !== 0 || !sameInode(parent, this.parentInode) || realpathSync(this.path) !== this.path) throw new Error(FAILURE);
    const current = lstatSync(this.path);
    if (!current.isDirectory() || !owned(current) || (current.mode & 0o777) !== 0o700 || !sameInode(current, this.inode)) throw new Error(FAILURE);
  }

  private syncDirectory(): void {
    this.checkDirectory();
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      if (!sameInode(fstatSync(fd), this.inode)) throw new Error(FAILURE);
      fsyncSync(fd);
      this.checkDirectory();
    } finally { closeSync(fd); }
  }

  private filename(id: string): string {
    if (!JOB_ID.test(id)) throw new Error(FAILURE);
    this.checkDirectory();
    return join(this.path, `${id}.json`);
  }

  put(job: PendingIdentity, command: string): void {
    let temp: string | undefined;
    try {
      const file = this.filename(job.id);
      if (!command.trim() || command.length > PENDING_COMMAND_MAX_CHARS || readdirSync(this.path).length >= this.maxCount) throw new Error();
      const data = JSON.stringify({ version: 1, binding: binding(job), command });
      if (Buffer.byteLength(data) > PENDING_PAYLOAD_MAX_BYTES) throw new Error();
      temp = join(this.path, `.${randomUUID()}.tmp`);
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      this.checkDirectory();
      // Atomic exclusive publication: never replace an existing payload.
      linkSync(temp, file);
      unlinkSync(temp);
      temp = undefined;
      this.syncDirectory();
    } catch {
      if (temp) { try { unlinkSync(temp); } catch { /* absent */ } }
      throw new Error(FAILURE);
    }
  }

  private readEntry(job: PendingIdentity): { command: string; inode: Stats } | null {
    let fd: number | undefined;
    try {
      const file = this.filename(job.id);
      const before = lstatSync(file);
      if (!before.isFile() || !owned(before) || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > PENDING_PAYLOAD_MAX_BYTES) return null;
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (!sameInode(before, opened)) return null;
      const buffer = Buffer.alloc(PENDING_PAYLOAD_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > PENDING_PAYLOAD_MAX_BYTES || !sameInode(lstatSync(file), opened)) return null;
      this.checkDirectory();
      const payload: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Parse untrusted JSON at its on-disk I/O boundary before accessing properties.
      if (!payload || typeof payload !== "object") return null;
      // SAFETY: payload is a non-null object; each asserted property remains unknown until the contract checks below.
      const value = payload as { version?: unknown; binding?: unknown; command?: unknown };
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The payload contract requires a string before trimming or bounding the command.
      return value.version === 1 && value.binding === binding(job) && typeof value.command === "string" && value.command.trim() && value.command.length <= PENDING_COMMAND_MAX_CHARS ? { command: value.command, inode: opened } : null;
    } catch { return null; }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  read(job: PendingIdentity): string | null { return this.readEntry(job)?.command ?? null; }

  // Durable removal is the launch claim.  Never spawn until it succeeds.
  claim(job: PendingIdentity): string | null {
    const entry = this.readEntry(job);
    if (entry === null) return null;
    if (!sameInode(lstatSync(this.filename(job.id)), entry.inode)) return null;
    this.remove(job.id);
    return entry.command;
  }

  remove(id: string): void {
    try {
      const file = this.filename(id);
      try { unlinkSync(file); }
      catch (error) {
        // SAFETY: synchronous Node filesystem errors carry an optional errno code; no other field is assumed.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.syncDirectory();
    } catch { throw new Error(FAILURE); }
  }

  reconcile(keep: ReadonlySet<string>): void {
    try {
      this.checkDirectory();
      for (const name of readdirSync(this.path)) {
        const id = name.endsWith(".json") ? name.slice(0, -5) : "";
        if (JOB_ID.test(id) && keep.has(id)) continue;
        // Unlink only; never follow a symlink or descend a directory.
        try { unlinkSync(join(this.path, name)); } catch { /* directory or absent */ }
      }
      this.syncDirectory();
    } catch { throw new Error(FAILURE); }
  }
}

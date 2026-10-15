// Durable, bounded queue for Zulip outgoing-webhook deliveries.  The HTTP
// receiver stores only the target bot and message id; content is fetched from
// Zulip through that bot's authenticated REST client before it is routed.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

export const ZULIP_OUTGOING_MAX_PENDING = 10_000;
export const ZULIP_OUTGOING_MAX_ATTEMPTS = 12;
const BOT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const FILE_NAME = /^([A-Za-z0-9][A-Za-z0-9_-]{0,95})-(\d{1,20})\.json$/;
const spoolItemSchema = z.object({
  botId: z.string(),
  messageId: z.number().int().safe(),
  attempts: z.number().int().safe().nonnegative().optional(),
});

export function supportsDirectoryFsync(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export interface ZulipOutgoingSpoolItem {
  botId: string;
  messageId: number;
}

export class ZulipOutgoingSpool {
  readonly directory: string;

  constructor(dataDir: string) {
    this.directory = join(dataDir, "zulip", "outgoing");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(this.directory, 0o700);
  }

  private name(botId: string, messageId: number): string {
    if (!BOT_ID.test(botId) || !Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new TypeError("invalid Zulip outgoing webhook identity");
    }
    return `${botId}-${messageId}.json`;
  }

  /** Atomically persist an event; false means the same valid row is pending. */
  add(botId: string, messageId: number): boolean {
    const name = this.name(botId, messageId);
    const path = join(this.directory, name);
    const expected = { botId, messageId };
    const names = readdirSync(this.directory);
    const count = names.filter((entry) => FILE_NAME.test(entry)).length;
    if (existsSync(path) && this.valid(path, expected)) {
      // A prior attempt may have installed the name and then failed the
      // directory fsync.  A retry must establish durability before acking.
      this.fsyncDirectory();
      return false;
    }
    if (count >= ZULIP_OUTGOING_MAX_PENDING && !existsSync(path)) throw new Error("Zulip outgoing webhook queue is full");

    // writeFileAtomic fsyncs the complete temporary file before rename.  The
    // final directory fsync makes the new name durable before HTTP 200.
    writeFileAtomic(path, `${JSON.stringify(expected)}\n`, { mode: 0o600 });
    this.fsyncDirectory();
    return true;
  }

  pending(): ZulipOutgoingSpoolItem[] {
    const rows: ZulipOutgoingSpoolItem[] = [];
    for (const entry of readdirSync(this.directory)) {
      const match = FILE_NAME.exec(entry);
      if (!match) continue;
      const [, botId, rawId] = match;
      const messageId = Number(rawId);
      if (!Number.isSafeInteger(messageId) || messageId <= 0) continue;
      const row = { botId: botId!, messageId };
      if (this.valid(join(this.directory, entry), row)) rows.push(row);
    }
    return rows.sort((a, b) => a.messageId - b.messageId || a.botId.localeCompare(b.botId));
  }

  remove(item: ZulipOutgoingSpoolItem): void {
    const path = join(this.directory, this.name(item.botId, item.messageId));
    try {
      unlinkSync(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    this.fsyncDirectory();
  }

  recordFailure(item: ZulipOutgoingSpoolItem): number {
    const path = join(this.directory, this.name(item.botId, item.messageId));
    const parsed = spoolItemSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success || parsed.data.botId !== item.botId || parsed.data.messageId !== item.messageId) {
      throw new Error("invalid Zulip outgoing webhook spool row");
    }
    const attempts = (parsed.data.attempts ?? 0) + 1;
    writeFileAtomic(path, `${JSON.stringify({ botId: item.botId, messageId: item.messageId, attempts })}\n`, { mode: 0o600 });
    this.fsyncDirectory();
    return attempts;
  }

  private valid(path: string, expected: ZulipOutgoingSpoolItem): boolean {
    try {
      const parsed = spoolItemSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      return parsed.success && parsed.data.botId === expected.botId &&
        parsed.data.messageId === expected.messageId;
    } catch {
      return false;
    }
  }

  private fsyncDirectory(): void {
    // Windows does not provide POSIX directory fsync semantics; the atomic
    // file replace remains in place, while directory syncing is best effort.
    if (!supportsDirectoryFsync()) return;
    const fd = openSync(this.directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}

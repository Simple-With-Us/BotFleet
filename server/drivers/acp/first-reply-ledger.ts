// Native sessions whose first prompt has not been answered yet.
//
// A session id is saved by the harness when session/new returns, before the
// first prompt comes back.  If that prompt fails or goes unanswered, the saved
// cursor points at a session that may never have carried the marker an engine
// titles it from.  The next turn resumes the cursor, finds it here, and asks for
// the marker again.  That turn is a new message: nothing already sent is resent.
//
// Kept on disk so a server restart does not forget it.  Reads that fail count
// as "nothing pending" (the marker is skipped, never repeated blindly), writes
// that fail are ignored (the in-process answer is still right), and the file is
// bounded so it cannot grow without limit.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dataDir } from "../../data-dir.ts";

const MAX_ENTRIES = 500;

function ledgerPath(): string {
  return join(dataDir(), "acp-first-reply-pending.json");
}

function read(): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function write(entries: string[]): void {
  try {
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries.slice(-MAX_ENTRIES)), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* best effort: the in-process answer does not depend on the file */
  }
}

const key = (instanceId: string, sessionId: string): string => `${instanceId}\u0000${sessionId}`;

/** True while the session's first prompt has not been answered. */
export function awaitingFirstReply(instanceId: string, sessionId: string): boolean {
  return read().includes(key(instanceId, sessionId));
}

export function markAwaitingFirstReply(instanceId: string, sessionId: string): void {
  const entries = read().filter((entry) => entry !== key(instanceId, sessionId));
  entries.push(key(instanceId, sessionId));
  write(entries);
}

export function clearAwaitingFirstReply(instanceId: string, sessionId: string): void {
  const entries = read();
  const next = entries.filter((entry) => entry !== key(instanceId, sessionId));
  if (next.length !== entries.length) write(next);
}

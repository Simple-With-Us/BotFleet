// Native sessions whose first marked prompt has not been answered yet.
//
// A session id is saved by the harness when session/new returns, before the
// first prompt comes back.  If that prompt fails or goes unanswered, the saved
// cursor points at a session that may never have carried the marker an engine
// titles it from.  The next turn resumes the cursor, finds it pending, and owes
// the marker again.  That turn is a new message: nothing already sent is resent.
//
// Leaving a marker off costs the user an unidentifiable thread; adding one
// twice costs a repeated tag in the text.  So every doubt below resolves toward
// "still owed", and a doubt is never silent.
//
// Storage is one file per pending session, and the file's EXISTENCE is the whole
// record.  There is nothing to parse, so a damaged or truncated file still counts
// as pending, and one session's file can never hide or clobber another's.  A
// write is a temp file renamed into place, a clear is an unlink, and drivers that
// touch different sessions touch different files, so concurrent drivers cannot
// lose each other's updates.  Nothing is ever expired: a record leaves only when
// its prompt is answered.  A session that never gets a reply leaves one tiny file
// behind, which costs a few bytes; dropping it by age or count could silently
// lose the identification for a cursor that is resumed later.
//
// What it cannot do, stated plainly: if the data directory cannot be written, the
// record lives in memory for this process only and a restart forgets it.  That
// is logged (a fixed line, no user text) rather than hidden.
import { createHash } from "node:crypto";
import { accessSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dataDir } from "../../data-dir.ts";

const MAX_ANSWERED_IN_MEMORY = 5000;

function ledgerDir(): string {
  return join(dataDir(), "acp-first-reply-pending");
}

function fileFor(instanceId: string, sessionId: string): string {
  const name = createHash("sha256").update(`${instanceId}\u0000${sessionId}`).digest("hex").slice(0, 40);
  return join(ledgerDir(), `${name}.pending`);
}

export interface FirstReplyLedger {
  /** True when the session's first marked prompt is not known to be answered.
   *  An unreadable ledger answers true: the marker may repeat, never go missing. */
  owed(sessionId: string): boolean;
  /** Record that a marked prompt is about to be sent.  Returns false when the
   *  record could not be written to disk (it is still held in memory). */
  record(sessionId: string): boolean;
  /** The agent answered: the marker has landed.  Returns false when the on-disk
   *  record could not be removed (it will not be owed again in this process). */
  answered(sessionId: string): boolean;
}

export function createFirstReplyLedger(instanceId: string, warn: (line: string) => void = (line) => console.warn(line)): FirstReplyLedger {
  // Held by this driver only.  `pending` covers a write that never reached the
  // disk; `done` covers a clear that did not, so one answered session is not
  // re-marked on every turn just because its file would not delete.
  const pending = new Set<string>();
  const done = new Set<string>();

  return {
    owed(sessionId) {
      if (done.has(sessionId)) return false;
      if (pending.has(sessionId)) return true;
      try {
        accessSync(fileFor(instanceId, sessionId));
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        warn("[acp] first-reply ledger unreadable; the session marker may be repeated once");
        return true;
      }
    },

    record(sessionId) {
      done.delete(sessionId);
      pending.add(sessionId);
      try {
        const dir = ledgerDir();
        mkdirSync(dir, { recursive: true });
        const path = fileFor(instanceId, sessionId);
        const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, `${Date.now()}\n`, { mode: 0o600 });
        renameSync(tmp, path);
        pending.delete(sessionId);
        return true;
      } catch {
        warn("[acp] first-reply ledger not writable; a restart before the first reply will forget the session marker");
        return false;
      }
    },

    answered(sessionId) {
      pending.delete(sessionId);
      done.add(sessionId);
      if (done.size > MAX_ANSWERED_IN_MEMORY) {
        const oldest = done.values().next();
        if (!oldest.done) done.delete(oldest.value);
      }
      try {
        unlinkSync(fileFor(instanceId, sessionId));
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
        warn("[acp] first-reply ledger entry could not be removed; the session marker may be repeated once after a restart");
        return false;
      }
    },
  };
}

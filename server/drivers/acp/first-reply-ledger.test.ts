import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFirstReplyLedger } from "./first-reply-ledger.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("first-reply ledger", () => {
  let root: string;
  let warnings: string[];
  const warn = (line: string) => void warnings.push(line);
  const ledger = (id = "inst") => createFirstReplyLedger(id, warn);
  const pendingDir = () => join(root, "acp-first-reply-pending");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "first-reply-ledger-"));
    vi.stubEnv("OMB_DATA_DIR", root);
    warnings = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is owed until answered, and a fresh ledger (a restart) sees the same state", () => {
    expect(ledger().owed("s1")).toBe(false);
    expect(ledger().record("s1")).toBe(true);
    expect(ledger().owed("s1")).toBe(true);
    expect(ledger().owed("s2")).toBe(false);
    expect(ledger("other-instance").owed("s1")).toBe(false);
    expect(ledger().answered("s1")).toBe(true);
    expect(ledger().owed("s1")).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("keeps a session owed when its record file is damaged, because the file's existence is the record", () => {
    ledger().record("s1");
    const file = join(pendingDir(), readdirSync(pendingDir())[0]);
    writeFileSync(file, "\u0000{{ not anything");
    expect(ledger().owed("s1")).toBe(true);
    writeFileSync(file, "");
    expect(ledger().owed("s1")).toBe(true);
  });

  it("cannot lose one session's record to damage in another's", () => {
    const a = ledger();
    a.record("s1");
    a.record("s2");
    const files = readdirSync(pendingDir());
    expect(files).toHaveLength(2);
    writeFileSync(join(pendingDir(), files[0]), "garbage");
    expect(ledger().owed("s1")).toBe(true);
    expect(ledger().owed("s2")).toBe(true);
  });

  it("holds the record in memory and says so when the directory cannot be written", () => {
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    vi.stubEnv("OMB_DATA_DIR", join(blocker, "data"));
    const driver = ledger();
    expect(driver.record("s1")).toBe(false);
    expect(warnings.some((line) => line.includes("not writable"))).toBe(true);
    // Same process: still owed after a failed first prompt.
    expect(driver.owed("s1")).toBe(true);
    // A restart cannot know it.  That is the stated limit, and it was logged above.
    // An unreadable ledger is treated as owed rather than as nothing pending.
    warnings.length = 0;
    expect(ledger().owed("s1")).toBe(true);
    expect(warnings.some((line) => line.includes("unreadable"))).toBe(true);
    // Once the agent answers in this process it is not owed again here.
    driver.answered("s1");
    expect(driver.owed("s1")).toBe(false);
  });

  it("stops re-marking an answered session even when its record cannot be deleted", () => {
    const driver = ledger();
    driver.record("s1");
    const file = join(pendingDir(), readdirSync(pendingDir())[0]);
    // Swap the file for a directory so the unlink fails with something other than "missing".
    rmSync(file);
    mkdirSync(file);
    warnings.length = 0;
    expect(driver.answered("s1")).toBe(false);
    expect(warnings.some((line) => line.includes("could not be removed"))).toBe(true);
    expect(driver.owed("s1")).toBe(false);
    // A fresh process still sees the leftover and owes one more marker: repeated once, never missing.
    expect(ledger().owed("s1")).toBe(true);
  });

  it("keeps every update when several drivers interleave on different and on the same sessions", async () => {
    const drivers = [ledger(), ledger(), ledger(), ledger()];
    const sessions = Array.from({ length: 120 }, (_, i) => `s${i}`);
    await Promise.all(
      sessions.map(async (session, i) => {
        const driver = drivers[i % drivers.length];
        await tick();
        driver.record(session);
        await tick();
        if (i % 2 === 0) driver.answered(session);
      }),
    );
    const fresh = ledger();
    for (const [i, session] of sessions.entries()) expect(fresh.owed(session), session).toBe(i % 2 === 1);
    expect(readdirSync(pendingDir()).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    // Same session from two drivers: the last operation wins, and no operation corrupts the record.
    const x = ledger();
    const y = ledger();
    await Promise.all([
      (async () => { for (let n = 0; n < 20; n++) { x.record("shared"); await tick(); } })(),
      (async () => { for (let n = 0; n < 20; n++) { y.record("shared"); await tick(); } })(),
    ]);
    expect(ledger().owed("shared")).toBe(true);
    x.answered("shared");
    expect(ledger().owed("shared")).toBe(false);
    expect(readdirSync(pendingDir()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("drops a record only by age, not because other sessions were added", () => {
    const old = ledger();
    old.record("stale");
    const staleFile = join(pendingDir(), readdirSync(pendingDir())[0]);
    const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(staleFile, longAgo, longAgo);
    // 600 other sessions do not push anything out, since there is no count cap.
    const driver = ledger();
    for (let i = 0; i < 600; i++) driver.record(`bulk-${i}`);
    for (let i = 0; i < 600; i++) expect(ledger().owed(`bulk-${i}`)).toBe(true);
    // The abandoned month-old one went at the first write after it aged out: the one deliberate loss.
    expect(ledger().owed("stale")).toBe(false);
  });
});

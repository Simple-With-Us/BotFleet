// HS9: backups this script writes into the data dir (`<file>.bak-merge-<stamp>`)
// were never pruned — a real fleet accumulated 90 MB of them. These tests
// cover pruneBackups directly (the pruning rule) and backup() (the wiring),
// without exercising main(), which needs a real bots.json/messages.db.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { backup, pruneBackups, BACKUP_KEEP } from "./merge-automation-tasks.mjs";

const temporaryDirectories = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-merge-automation-"));
  temporaryDirectories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pruneBackups", () => {
  it("keeps only the newest three backups for a file, by name", () => {
    const dir = tmp();
    const target = path.join(dir, "bots.json");
    const names = [
      "bots.json.bak-merge-2026-01-01T00-00-00-000Z",
      "bots.json.bak-merge-2026-01-02T00-00-00-000Z",
      "bots.json.bak-merge-2026-01-03T00-00-00-000Z",
      "bots.json.bak-merge-2026-01-04T00-00-00-000Z",
      "bots.json.bak-merge-2026-01-05T00-00-00-000Z",
    ];
    for (const name of names) fs.writeFileSync(path.join(dir, name), "x");

    pruneBackups(target);

    // the dashed ISO stamp keeps the fixed-width structure a timestamp has,
    // so a plain name sort is a chronological sort — the newest 3 survive
    expect(fs.readdirSync(dir).sort()).toEqual(names.slice(2));
  });

  it("does nothing when at or under the keep count", () => {
    const dir = tmp();
    const target = path.join(dir, "messages.db");
    const names = [
      "messages.db.bak-merge-2026-01-01T00-00-00-000Z",
      "messages.db.bak-merge-2026-01-02T00-00-00-000Z",
    ];
    for (const name of names) fs.writeFileSync(path.join(dir, name), "x");

    pruneBackups(target);
    expect(fs.readdirSync(dir).sort()).toEqual(names);
  });

  it("only touches backups for its own file, by prefix", () => {
    const dir = tmp();
    const botsNames = Array.from({ length: 4 }, (_, i) => `bots.json.bak-merge-2026-01-0${i + 1}T00-00-00-000Z`);
    const dbNames = Array.from({ length: 4 }, (_, i) => `messages.db.bak-merge-2026-01-0${i + 1}T00-00-00-000Z`);
    for (const name of [...botsNames, ...dbNames]) fs.writeFileSync(path.join(dir, name), "x");

    pruneBackups(path.join(dir, "bots.json"));

    const remaining = fs.readdirSync(dir).sort();
    expect(remaining.filter((n) => n.startsWith("bots.json"))).toEqual(botsNames.slice(1));
    expect(remaining.filter((n) => n.startsWith("messages.db"))).toEqual(dbNames);
  });

  it("survives a directory that does not exist", () => {
    expect(() => pruneBackups(path.join(tmp(), "nope", "bots.json"))).not.toThrow();
  });

  it("keeps three", () => {
    expect(BACKUP_KEEP).toBe(3);
  });
});

describe("backup", () => {
  it("copies the file and prunes older backups down to the keep count", () => {
    const dir = tmp();
    const source = path.join(dir, "bots.json");
    fs.writeFileSync(source, JSON.stringify({ bots: [] }));
    // three pre-existing "older" backups, timestamped well before any real
    // stamp backup() mints, so this one push crosses the limit
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(dir, `bots.json.bak-merge-2020-01-0${i}T00-00-00-000Z`), "old");
    }

    const created = backup(source);

    expect(fs.existsSync(created)).toBe(true);
    const backups = fs.readdirSync(dir).filter((n) => n.startsWith("bots.json.bak-merge-"));
    expect(backups).toHaveLength(3);
    expect(backups).toContain(path.basename(created));
    // the oldest fabricated backup is what got pruned
    expect(backups).not.toContain("bots.json.bak-merge-2020-01-01T00-00-00-000Z");
  });

  it("does not prune anything when under the keep count", () => {
    const dir = tmp();
    const source = path.join(dir, "messages.db");
    fs.writeFileSync(source, "data");

    backup(source);
    backup(source);

    const backups = fs.readdirSync(dir).filter((n) => n.startsWith("messages.db.bak-merge-"));
    expect(backups.length).toBeLessThanOrEqual(2);
  });
});

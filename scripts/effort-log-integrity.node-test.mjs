import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

// docs/EFFORT-LOG.md is the fleet's shared coordination ledger, and it was
// truncated on main from 716 rows to 9 by a single pull request — every seat's
// history at once (CLAUDE 86 rows to 0, CODEX 42 to 0, GROK 55 to 0).  The
// cause is a one-character mistake that looks completely harmless:
//
//     open(path, "w").write(row + open(path).read())
//
// Python evaluates `open(path, "w")` first, which TRUNCATES the file, and only
// then evaluates the argument, which reads the now-empty file.  So it writes
// `row + ""` — the new row alone, and every other seat's history gone.  It
// cannot fail, cannot raise, and produces a file that looks perfectly valid.
//
// It was introduced independently on at least two lanes in the same hour, and
// one of them reached main.  A doc file that only ever grows is therefore a
// thing CI can check, and this is that check: a change that removes more rows
// than it adds is a truncation, not an edit, whatever the commit says.

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "docs/EFFORT-LOG.md";

const countRows = (text) => (text.match(/^- \*\*/gm) || []).length;

test("the effort ledger is a growing record, not a file to be rewritten", async (t) => {
  // Work out the comparison point ourselves so the check runs in CI, in a
  // worktree, and locally, rather than depending on a variable some caller has
  // to remember to export.
  let base = process.env.MERGE_BASE;
  if (!base) {
    try {
      const { stdout } = await run("git", ["merge-base", "origin/main", "HEAD"], { cwd: root });
      base = stdout.trim();
    } catch {
      t.skip("no merge base with origin/main to compare against");
      return;
    }
  }
  if (!base) {
    t.skip("no merge base with origin/main to compare against");
    return;
  }
  const [before, after] = await Promise.all([
    run("git", ["show", `${base}:${LEDGER}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }),
    readFileSync(join(root, LEDGER), "utf8"),
  ]);
  const beforeRows = countRows(before.stdout);
  const afterRows = countRows(after);

  assert.ok(
    afterRows >= beforeRows,
    `docs/EFFORT-LOG.md lost rows: ${beforeRows} at ${base.slice(0, 9)}, ${afterRows} now. ` +
      `If rows were genuinely obsolete, delete them in a commit that says so and explains which, ` +
      `rather than as a side effect of appending one.  A common cause is ` +
      `open(path, "w").write(row + open(path).read()), which truncates before it reads.`,
  );
});

test("the ledger still holds the fleet's history", () => {
  // A floor, not an exact count: seats keep adding rows, and this only has to
  // notice a collapse.  Every seat listed here had dozens of rows before the
  // truncation reached main.
  const text = readFileSync(join(root, LEDGER), "utf8");
  const rows = countRows(text);
  assert.ok(rows > 400, `docs/EFFORT-LOG.md has only ${rows} rows; this looks like a truncation`);

  for (const seat of ["AG", "CLAUDE", "CODEX", "GROK", "MINIMAX"]) {
    const seatRows = (text.match(new RegExp(`^- \\*\\*[0-9]{4}-[0-9]{2}-[0-9]{2} — ${seat} `, "gm")) || []).length;
    assert.ok(seatRows > 0, `no rows left for ${seat} in ${LEDGER}`);
  }
});

// An ordering test was here and was deliberately removed.  The file is not
// reliably one ordered list: at least one seat writes it with `## Completed`
// and `## In Progress` section headers, so "newest first" does not hold across
// the whole file.  A test that fails on legitimate content trains people to
// ignore it, and the two checks above are the ones that actually caught the
// truncation.  Chronology is a convention for humans here, not an invariant.

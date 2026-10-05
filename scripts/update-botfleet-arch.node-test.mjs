import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The updater bootstraps itself by archiving a fixed set of files out of the
// commit it is about to install (scripts/update-botfleet.sh) and running that
// copy.  The set is a literal list in the shell, so nothing in the JavaScript
// notices when a new local import is added: the archive is simply missing the
// file, and `ubf` dies with ERR_MODULE_NOT_FOUND on every Mac at the moment it
// is trying to recover from a failed update.  The only warning was a comment.
//
// This test makes the list enforced instead of advisory.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LOCAL_IMPORT = /from\s+"(\.[^"]+)"/g;

async function archivedPaths() {
  const wrapper = await readFile(join(root, "scripts/update-botfleet.sh"), "utf8");
  const archive = wrapper.match(/git -C "\$BOTFLEET_CHECKOUT" archive[^|]*?--\s*((?:[\\\s]+[\w.\/-]+)+?)\s*\|/);
  assert.ok(archive, "could not find the `git archive` call in scripts/update-botfleet.sh");
  // The paths sit on shell line-continuation lines, so the captured group also
  // contains the backslashes that join them.
  return new Set(archive[1].split(/\s+/).filter((token) => token && !token.includes("\\")));
}

test("every module the updater imports locally is in the bootstrap archive", async () => {
  const archived = await archivedPaths();
  const entry = join(root, "scripts/update-botfleet-mac.mjs");
  const source = await readFile(entry, "utf8");
  const missing = [];
  for (const match of source.matchAll(LOCAL_IMPORT)) {
    // Relative to the importing file, which is scripts/.
    const imported = match[1].replace(/^\.\//, "");
    if (imported.startsWith("..")) continue; // electron/ and shared/ are not archived today
    if (!archived.has(`scripts/${imported}`)) missing.push(`scripts/${imported}`);
  }
  assert.deepEqual(
    [...new Set(missing)],
    [],
    "these modules are imported but not archived by scripts/update-botfleet.sh, so a bootstrapped ubf would fail to start on every Mac",
  );
});

test("the archive list names files that exist", async () => {
  const archived = await archivedPaths();
  for (const path of archived) {
    await readFile(join(root, path), "utf8");
  }
  assert.ok(archived.size > 0);
});

test("the stage-entry allowlist has exactly one definition, and the server uses it", async () => {
  // Two copies of this list existed: one in update-botfleet-mac.mjs and one in
  // server/update-control.ts, each with a comment claiming parity with the
  // other.  They drifted, and only the server's copy decides what the harness
  // prunes, so every stage the default `ci` policy produced was kept forever
  // with a full extra copy of the app and a multi-gigabyte dependency tree.
  const updater = await readFile(join(root, "scripts/update-botfleet-mac.mjs"), "utf8");
  const server = await readFile(join(root, "server/update-control.ts"), "utf8");

  assert.doesNotMatch(updater, /const KNOWN_STAGE_ENTRIES = new Set/, "the updater must not redeclare the allowlist");
  assert.doesNotMatch(server, /const KNOWN_STAGE_ENTRIES = new Set/, "the server must not redeclare the allowlist");
  assert.doesNotMatch(server, /PROTECTED_STAGE_ENTRIES = new Set/);
  assert.match(updater, /from "\.\/stage-entries\.mjs"/);
  assert.match(server, /from "\.\.\/scripts\/stage-entries\.mjs"/);

  // A `hosted` stage is the one the ci policy produces on every update, so if
  // it is ever dropped from the shared list the leak returns silently.
  const { KNOWN_STAGE_ENTRIES, stageIsPrunable } = await import("./stage-entries.mjs");
  assert.ok(KNOWN_STAGE_ENTRIES.includes("hosted"), "a CI-built stage must be sweepable");
  assert.equal(stageIsPrunable(["hosted", "node_modules", "source"]), true);
  assert.equal(stageIsPrunable(["prepared.json", "hosted"]), false, "a reusable stage is load-bearing");
  assert.equal(stageIsPrunable(["rollback", "hosted"]), false, "the rollback bundle is load-bearing");
  assert.equal(stageIsPrunable(["hosted", "someones-notes.txt"]), false, "a person's file is not ours to delete");
});

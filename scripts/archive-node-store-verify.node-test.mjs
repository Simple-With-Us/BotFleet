// Checking a capture where it lies.
//
// The manifest comparison lived inside the restore, so the only way to ask
// whether a capture was intact was to write a copy of it out first.  These
// tests prove the read-only check:  it reads the manifest and the tree, it
// writes nothing, and a tampered capture is caught by the check rather than
// only by a restore.
//
// Every fixture here is built in a temporary directory.  Nothing in this file
// reads, copies or hashes a real store on any host, so the proof never runs
// against the owner's own data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { archiveStore, verifyArchive } from "./archive-node-store.mjs";

const ROOT_IS_ROOT = Boolean(process.getuid) && process.getuid() === 0;

/** The tool, run as a child process so its own answer is the thing under test. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), "archive-node-store.mjs");

/** A private scratch directory, which is what the archive requires. */
function privateScratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A synthetic store with the attachments the app keeps beside it.
 *
 * The attachment directory is part of the store, so a capture covers it
 * because there is nothing to switch on.
 */
function makeSyntheticStore() {
  const root = privateScratch("verify-store-");
  mkdirSync(join(root, "attachments"), { recursive: true });
  writeFileSync(join(root, "attachments", "22222222-2222-4222-8222-222222222222.txt"), "an ordinary text attachment\n");
  writeFileSync(join(root, "bots.json"), `${JSON.stringify({ bots: [{ id: "1", name: "one" }] }, null, 2)}\n`);
  return root;
}

/** Every file under a directory, so a check can be shown to have written nothing. */
function fileList(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full.slice(root.length + 1));
    }
  };
  walk(root);
  return found.sort();
}

test("a capture is checked where it lies, without being restored", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("verify-");
  const captureDir = join(parent, "capture");
  const { manifest } = await archiveStore({ storeRoot: store, outDir: captureDir });

  const verdict = verifyArchive({ captureDir });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.mismatches));
  assert.equal(verdict.expectedFiles, manifest.totals.files);
  assert.equal(verdict.verifiedFiles, verdict.expectedFiles);
  assert.equal(existsSync(join(parent, "restored")), false, "the check restored nothing");
});

test("the check writes nothing into the capture", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("verify-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });

  const before = fileList(captureDir);
  verifyArchive({ captureDir });
  assert.deepEqual(fileList(captureDir), before, "the check wrote into the capture");
});

test("a tampered capture is caught by the check, not only by the restore", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("verify-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  chmodSync(join(captureDir, "tree"), 0o755);
  chmodSync(join(captureDir, "tree", "bots.json"), 0o644);
  writeFileSync(join(captureDir, "tree", "bots.json"), `${JSON.stringify({ bots: [{ id: "tampered" }] }, null, 2)}\n`);

  const verdict = verifyArchive({ captureDir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.mismatches.length, 1);
  assert.equal(verdict.mismatches[0].path, "bots.json");
  assert.equal(verdict.mismatches[0].reason, "archive-hash-mismatch");
});

test("the verify command answers with a verdict and writes nothing", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("verify-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  const before = fileList(captureDir);

  const run = spawnSync(process.execPath, [CLI, "verify", "--capture", captureDir], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const answer = JSON.parse(run.stdout);
  assert.equal(answer.verified, true);
  assert.equal(answer.mismatches, 0);
  assert.ok(answer.verifiedFiles > 0);
  assert.deepEqual(fileList(captureDir), before, "the command wrote into the capture");
});

test("a file added to the tree is caught by the check", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("verify-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  // A capture that was added to after it was written still carries a manifest
  // that hashes every file it names, so only reading the tree itself shows the
  // extra file.
  chmodSync(join(captureDir, "tree"), 0o755);
  writeFileSync(join(captureDir, "tree", "added.json"), "{}\n");

  const verdict = verifyArchive({ captureDir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.mismatches.length, 1);
  assert.equal(verdict.mismatches[0].path, "added.json");
  assert.equal(verdict.mismatches[0].reason, "unlisted-tree-file");
  assert.equal(verdict.verifiedFiles, verdict.expectedFiles, "the named files still verified");
});

test("a manifest without a file list is a finding, not a crash", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("verify-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  const manifestPath = join(captureDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.files;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verdict = verifyArchive({ captureDir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.mismatches.length, 1);
  assert.equal(verdict.mismatches[0].path, "manifest.json");
  assert.equal(verdict.mismatches[0].reason, "manifest-files-missing");
});

test("a totals disagreement does not move the verified file count", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("verify-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  const manifestPath = join(captureDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.totals.files = manifest.files.length + 1;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verdict = verifyArchive({ captureDir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.mismatches.length, 1);
  assert.equal(verdict.mismatches[0].path, "manifest.json");
  assert.equal(verdict.mismatches[0].reason, "totals-mismatch");
  // The named files were each checked on their own, so the count does not
  // move and it never goes negative.
  assert.equal(verdict.verifiedFiles, verdict.expectedFiles);
});

test("the verify command fails on a tampered capture and says so", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeSyntheticStore();
  const parent = privateScratch("verify-");
  const captureDir = join(parent, "capture");
  await archiveStore({ storeRoot: store, outDir: captureDir });
  chmodSync(join(captureDir, "tree"), 0o755);
  chmodSync(join(captureDir, "tree", "bots.json"), 0o644);
  writeFileSync(join(captureDir, "tree", "bots.json"), "tampered\n");

  const run = spawnSync(process.execPath, [CLI, "verify", "--capture", captureDir], { encoding: "utf8" });
  assert.equal(run.status, 1);
  const answer = JSON.parse(run.stdout);
  assert.equal(answer.verified, false);
  assert.equal(answer.mismatches, 1);
});

// The bounds of a Node store capture:  what it refuses, what it leaves behind, and how a capture
// is checked without being restored.
//
// The properties under test are the ones a rollback depends on:  a capture over its ceilings is
// refused before anything is written, a refused capture leaves nothing that could pass for
// evidence, the attachment directory is covered without a flag, and a capture can be verified
// where it lies, so a check is never a restore in disguise.
//
// The store here is synthetic and holds no credential shape at all:  these properties are about
// the bounds and the manifest, and a credential fixture would only bring the secret scan along.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveStore, verifyArchive } from "./archive-node-store.mjs";

const ROOT_IS_ROOT = Boolean(process.getuid) && process.getuid() === 0;

/** A private scratch directory, which is what the archive requires. */
function privateScratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A synthetic store with the attachments the app keeps beside it.
 *
 * The attachment directory is part of the store, so a capture covers it because there is nothing
 * to switch on.  The fixture says so out loud:  a capture that quietly left the attachments
 * behind would look exactly like one that covered them, unless a test asks.
 */
function makeStoreWithAttachments() {
  const root = privateScratch("store-");
  mkdirSync(join(root, "attachments"), { recursive: true });
  writeFileSync(join(root, "attachments", "note.txt"), "an attachment");
  writeFileSync(join(root, "attachments", "photo.bin"), Buffer.from([0x10, 0x20, 0x30]));
  writeFileSync(join(root, "bots.json"), JSON.stringify({ bots: [{ id: "1" }] }, null, 2));
  return root;
}

test("a capture covers the attachments by default, with nothing to switch on", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStoreWithAttachments();
  const parent = privateScratch("capture-");
  const { manifest, outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });

  const paths = manifest.files.map((row) => row.path);
  assert.ok(paths.includes("attachments/note.txt"), JSON.stringify(paths));
  assert.ok(paths.includes("attachments/photo.bin"), JSON.stringify(paths));
  assert.ok(existsSync(join(outDir, "tree", "attachments", "note.txt")));
});

test("a capture over the byte ceiling is refused, and leaves nothing behind", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStoreWithAttachments();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await assert.rejects(
    () => archiveStore({ storeRoot: store, outDir: captureDir, maxBytes: 32 }),
    /byte ceiling/,
  );
  assert.equal(existsSync(captureDir), false, "a refused capture leaves no directory behind");
});

test("a capture over the file ceiling is refused, and leaves nothing behind", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStoreWithAttachments();
  const parent = privateScratch("capture-");
  const captureDir = join(parent, "capture");
  await assert.rejects(
    () => archiveStore({ storeRoot: store, outDir: captureDir, maxFiles: 2 }),
    /ceiling/,
  );
  assert.equal(existsSync(captureDir), false, "a refused capture leaves no directory behind");
});

test("a store inside the ceilings is captured whole", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStoreWithAttachments();
  const parent = privateScratch("capture-");
  const { manifest } = await archiveStore({
    storeRoot: store,
    outDir: join(parent, "capture"),
    maxBytes: 1024 * 1024,
    maxFiles: 100,
  });
  assert.ok(manifest.totals.files > 0);
  assert.ok(manifest.totals.bytes > 0);
  assert.equal(manifest.totals.excluded >= 0, true);
});

test("a capture is checked where it lies, without being restored", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStoreWithAttachments();
  const parent = privateScratch("capture-");
  const { outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });

  const verdict = verifyArchive({ captureDir: outDir });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.mismatches));
  assert.ok(verdict.files > 0);
  assert.equal(existsSync(join(parent, "restored")), false, "the check restored nothing");
});

test("a tampered capture is caught by the check, not only by the restore", { skip: ROOT_IS_ROOT }, async () => {
  const store = makeStoreWithAttachments();
  const parent = privateScratch("capture-");
  const { outDir } = await archiveStore({ storeRoot: store, outDir: join(parent, "capture") });
  chmodSync(join(outDir, "tree"), 0o755);
  chmodSync(join(outDir, "tree", "bots.json"), 0o644);
  writeFileSync(join(outDir, "tree", "bots.json"), JSON.stringify({ bots: [{ id: "tampered" }] }));

  const verdict = verifyArchive({ captureDir: outDir });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.mismatches[0].path, "bots.json");
  assert.equal(verdict.mismatches[0].reason, "hash-mismatch");
});

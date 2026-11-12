import { closeSync, constants, fstatSync, linkSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openedFileIsListedSync } from "./opened-file.ts";

it("refuses a listed inode swap or hard link while preserving the opened file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bf-opened-file-"));
  const path = join(dir, "host-id");
  writeFileSync(path, "old");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    expect(openedFileIsListedSync(fstatSync(fd), path)).toBe(true);
    linkSync(path, join(dir, "alias"));
    expect(openedFileIsListedSync(fstatSync(fd), path)).toBe(false);
    rmSync(join(dir, "alias"));
    renameSync(path, join(dir, "old"));
    writeFileSync(path, "replacement");
    expect(openedFileIsListedSync(fstatSync(fd), path)).toBe(false);
  } finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
});

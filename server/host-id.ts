import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HOST_ID_PATTERN, type HostId } from "../shared/placement.ts";
import { writeFileAtomic } from "./atomic.ts";

/** Local identity belongs to the data directory, independent of code updates. */
export function loadHostId(dataDir: string, platform: NodeJS.Platform = process.platform): HostId {
  const path = join(dataDir, "host-id");
  const read = (): HostId => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("host-id must be a regular file");
      const value = readFileSync(fd, "utf8").trim();
      if (!HOST_ID_PATTERN.test(value)) throw new Error("host-id is invalid; preserve it and restore the host identity before starting");
      fchmodSync(fd, 0o600);
      return value as HostId;
    } finally {
      closeSync(fd);
    }
  };
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const candidate = `${path}.${randomUUID()}.pending`;
  try {
    writeFileAtomic(candidate, `${platform === "darwin" ? "mac" : "server"}:${randomUUID()}\n`, { mode: 0o600 });
    try {
      // Publish only a complete inode, without replacing another starter's id.
      linkSync(candidate, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    try { unlinkSync(candidate); } catch { /* best-effort temporary-file cleanup */ }
  }
  return read();
}

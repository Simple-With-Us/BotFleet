import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { HOST_ID_PATTERN, type HostId } from "../shared/placement.ts";
import { writeFileAtomic } from "./atomic.ts";
import { openedFileIsListedSync } from "./opened-file.ts";

/** Local identity belongs to the data directory, independent of code updates. */
export function loadHostId(dataDir: string, platform: NodeJS.Platform = process.platform): HostId {
  // Match the harness ownership fence: the configured data root may be a
  // user-owned alias; final host-id entries still require a verified handle.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = realpathSync(dataDir);
  const path = join(directory, "host-id");
  const publicationAlias = (opened: Stats): string | undefined => {
    if (opened.nlink !== 2) return undefined;
    return readdirSync(directory).find((name) => {
      if (!/^host-id\.[0-9a-f-]{36}\.pending$/.test(name)) return false;
      try {
        const alias = lstatSync(join(directory, name));
        return alias.isFile() && !alias.isSymbolicLink() && alias.dev === opened.dev && alias.ino === opened.ino;
      } catch { return false; }
    });
  };
  const read = (): HostId => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      let opened = fstatSync(fd);
      // A concurrent creator briefly has both the pending and published names.
      // Give a live publisher time to remove its verified temporary alias.
      const wait = new Int32Array(new SharedArrayBuffer(4));
      for (let attempt = 0; opened.nlink !== 1 && attempt < 50 && publicationAlias(opened); attempt++) {
        Atomics.wait(wait, 0, 0, 10);
        opened = fstatSync(fd);
      }
      opened = fstatSync(fd);
      // A creator may have died after linkSync. Recover only this inode's
      // publication alias; unrelated hard links remain a startup error.
      const staleAlias = publicationAlias(opened);
      if (staleAlias) {
        const aliasPath = join(directory, staleAlias);
        try {
          const published = lstatSync(path);
          const alias = lstatSync(aliasPath);
          if (published.isFile() && !published.isSymbolicLink() && published.nlink === 2 &&
              published.dev === opened.dev && published.ino === opened.ino &&
              alias.isFile() && !alias.isSymbolicLink() && alias.nlink === 2 &&
              alias.dev === opened.dev && alias.ino === opened.ino) unlinkSync(aliasPath);
        } catch (error) {
          // Another reader or the original publisher may have cleaned it first.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        opened = fstatSync(fd);
      }
      if (!openedFileIsListedSync(opened, path)) throw new Error("host-id must be the listed regular file with one link");
      const value = readFileSync(fd, "utf8").trim();
      if (!HOST_ID_PATTERN.test(value)) throw new Error("host-id is invalid; preserve it and restore the host identity before starting");
      if (!openedFileIsListedSync(fstatSync(fd), path)) throw new Error("host-id changed while it was read");
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

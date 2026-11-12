// Read the harness Infisical token through a verified handle.
//
// Mirrors readBootstrapTokenFile in electron/infisical-read.mjs: the file is
// opened with O_RDONLY|O_NOFOLLOW, checked on the open descriptor, and read
// only from that descriptor. The token is written only to stdout (captured
// by start.sh); a refusal is one value-free reason on stderr.
import fs from "node:fs";

function fail(reason) {
  throw new Error(reason);
}

const file = process.argv[2] ?? "";
if (!file || process.argv.length !== 3) {
  console.error("it cannot be read");
  process.exitCode = 1;
} else {
  let fd;
  try {
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      if (err?.code === "ELOOP") fail("it is a symlink");
      if (err?.code === "ENOENT") fail("it does not exist");
      fail("it cannot be read");
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) fail("it is not a regular file");
      if (stat.nlink !== 1) fail("it has more than one hard link");
      const geteuid = process.geteuid;
      const euid = Object.prototype.toString.call(geteuid) === "[object Function]" ? geteuid() : null;
      if (euid !== null && stat.uid !== euid) fail("it is not owned by the current user");
      if ((stat.mode & 0o077) !== 0) {
        fail(`it has group or other permission bits (mode ${(stat.mode & 0o777).toString(8)})`);
      }
      let pathStat;
      try {
        pathStat = fs.lstatSync(file);
      } catch {
        fail("it changed while it was read");
      }
      if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) fail("it changed while it was read");
      const content = fs.readFileSync(fd, "utf8");
      process.stdout.write(content.trim());
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : "it cannot be read");
    process.exitCode = 1;
  }
}

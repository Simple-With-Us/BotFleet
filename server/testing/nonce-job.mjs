// A job that leaves one file per run, so a fixture can count real spawns
// rather than trust a report about them (BF-2642).
//
// Usage: node nonce-job.mjs <directory> <nonce> [holdMilliseconds]
//
// Every run creates its own `<nonce>.<pid>.run` file before doing anything
// else.  One run leaves one file and two runs leave two, however either of
// them ended.
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { join } from "node:path";

const [directory, nonce, hold = "0"] = process.argv.slice(2);
if (!directory || !nonce || !/^[A-Za-z0-9_-]+$/.test(nonce)) {
  console.error("usage: nonce-job.mjs <directory> <nonce> [holdMilliseconds]");
  process.exit(2);
}
const fd = openSync(join(directory, `${nonce}.${process.pid}.run`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
writeSync(fd, `${process.pid}\n`);
closeSync(fd);
const holdMs = Number(hold);
if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));

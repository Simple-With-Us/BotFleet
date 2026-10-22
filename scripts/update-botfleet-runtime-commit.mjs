#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof -- hand-written owner-record/HTTP boundary parse; zod is unavailable in the updater bootstrap graph. */
// Query the live harness /api/runtime sourceCommit for the ubf up-to-date
// shortcut.  The whole exchange happens in this one process: the harness port
// and its credential are read from harness-owner.json (OWNER_FILE_PATH) here
// and used here, so the credential never crosses a process boundary as argv,
// an environment variable or output.  The harness mints a new credential every
// time it boots, so only the file is current; nothing the caller exported
// earlier can be trusted to be.  Only a 40-hex commit may be written to stdout.
//
// Exit codes:  0 a commit was printed;  1 nothing could be learned (no record,
// nothing listening, an unexpected answer);  2 the caller did not say which
// file;  3 the harness refused the credential in its own record, which the
// caller must not read as "current".
import { readFileSync } from "node:fs";
import http from "node:http";

const ownerPath = process.env.OWNER_FILE_PATH;

if (typeof ownerPath !== "string" || ownerPath.length === 0) {
  process.stderr.write("BotFleet updater: OWNER_FILE_PATH is required.\n");
  process.exit(2);
}

let owner;
try {
  owner = JSON.parse(readFileSync(ownerPath, "utf8"));
} catch {
  process.exit(1);
}

const port = owner && owner.port;
if (typeof port !== "number" && typeof port !== "string") process.exit(1);
const portNum = Number(port);
if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) process.exit(1);
const credential = owner && owner.nonce;
if (typeof credential !== "string" || !/^[a-f0-9]{64}$/.test(credential)) process.exit(1);

const req = http.request({
  hostname: "127.0.0.1",
  port: portNum,
  path: "/api/runtime",
  method: "GET",
  headers: { Authorization: `Bearer ${credential}` },
  // A Mac at a load average in the hundreds answers slowly, not wrongly.
  timeout: 10_000,
}, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      process.stderr.write(`BotFleet updater: the running harness refused the credential in ${ownerPath} (HTTP ${res.statusCode}).\n`);
      process.exit(3);
    }
    if (res.statusCode !== 200) process.exit(1);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      process.exit(1);
    }
    const commit = parsed && typeof parsed === "object" && parsed !== null ? parsed.sourceCommit : undefined;
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) process.exit(1);
    process.stdout.write(commit);
    process.exit(0);
  });
});
req.on("error", () => process.exit(1));
req.on("timeout", () => {
  req.destroy();
  process.exit(1);
});
req.end();
/* oxlint-enable anti-slop/no-runtime-typeof */

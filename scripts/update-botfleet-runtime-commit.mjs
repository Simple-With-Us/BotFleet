#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof -- hand-written env/HTTP boundary parse; zod is unavailable in the updater bootstrap graph. */
// Query the live harness /api/runtime sourceCommit for the ubf up-to-date
// shortcut.  Prefer BOTFLEET_OWNER_NONCE and fall back to the live owner
// record in harness-owner.json via OWNER_FILE_PATH so terminal ubf runs work.
// Only a 40-hex commit may be written to stdout.
import { readFileSync } from "node:fs";
import http from "node:http";

const ownerPath = process.env.OWNER_FILE_PATH;
const envCredential = process.env.BOTFLEET_OWNER_NONCE;

function maskedCredentialEnvRef(value) {
  if (typeof value !== "string" || value.length === 0) return "BOTFLEET_OWNER_NONCE";
  if (value.length <= 12) return "BOTFLEET_OWNER_NONCE (value too short to preview safely)";
  return `BOTFLEET_OWNER_NONCE (${value.slice(0, 8)}…${value.slice(-4)})`;
}

if (typeof ownerPath !== "string" || ownerPath.length === 0) {
  process.stderr.write("BotFleet updater: OWNER_FILE_PATH is required.\n");
  process.exit(2);
}
if (typeof envCredential === "string" && envCredential.length > 0 && !/^[a-f0-9]{64}$/.test(envCredential)) {
  process.stderr.write(`BotFleet updater: ${maskedCredentialEnvRef(envCredential)} is not a valid harness bearer credential.\n`);
  process.exit(2);
}

let owner;
try {
  owner = JSON.parse(readFileSync(ownerPath, "utf8"));
} catch {
  process.exit(1);
}

const credential = typeof envCredential === "string" && envCredential.length > 0
  ? envCredential
  : owner && typeof owner.nonce === "string" && /^[a-f0-9]{64}$/.test(owner.nonce)
    ? owner.nonce
    : "";
if (!credential) {
  process.stderr.write("BotFleet updater: BOTFLEET_OWNER_NONCE is required when a harness owner record exists.\n");
  process.exit(2);
}

const port = owner && owner.port;
if (typeof port !== "number" && typeof port !== "string") process.exit(1);
const portNum = Number(port);
if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) process.exit(1);

const req = http.request({
  hostname: "127.0.0.1",
  port: portNum,
  path: "/api/runtime",
  method: "GET",
  headers: { Authorization: `Bearer ${credential}` },
  timeout: 1000,
}, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      process.stderr.write(`BotFleet updater: harness rejected ${maskedCredentialEnvRef(credential)} (HTTP ${res.statusCode}).\n`);
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

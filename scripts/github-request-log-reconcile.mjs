#!/usr/bin/env node
/** Reconcile the GitHub request log against the org hook's server-side
 *  delivery history.  If a delivery never landed in the log (the spool-write
 *  failure window: dispatch ACKed 200, so GitHub will not retry on its own),
 *  request a REDELIVERY through GitHub - the dedicated request-log endpoint
 *  never dispatches, so re-ingest is safe and dedupe by delivery id keeps it
 *  idempotent.  Deliveries GitHub no longer retains (or failed redeliveries)
 *  get an explicit gap-marker line appended to the Markdown log instead of
 *  silence.  All writes are append-only; the BotFleet server stays the only
 *  spool writer.
 *
 *  Usage: node scripts/github-request-log-reconcile.mjs \
 *    --org Simple-With-Us --hook <org-hook-id> \
 *    --log ~/.botfleet/github-request-log.md \
 *    --cursor ~/.botfleet/github-request-log.reconcile-cursor
 *
 *  Needs an admin:org_hook credential on `gh`.  Read-only except redelivery
 *  attempts and gap-marker appends. */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

export function parseArgs(argv) {
  const args = { org: undefined, hook: undefined, log: undefined, cursor: undefined };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in args)) throw new Error(`unknown argument ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  for (const [key, value] of Object.entries(args)) {
    if (!value) throw new Error(`missing --${key}`);
  }
  return args;
}

export function loggedDeliveryIds(logPath, tailBytes = 65536) {
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return new Set();
  }
  const ids = new Set();
  for (const match of text.slice(-tailBytes).matchAll(/\(delivery ([^)]+)\)/g)) ids.add(match[1]);
  return ids;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gapLine(missing) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const ids = missing.map((d) => d.guid ?? d.id).join(", ");
  return `- ${ts} reconcile [gap] via github-request-log (${missing.length} deliver${missing.length === 1 ? "y" : "ies"} unrecoverable: ${ids}) (delivery gap-${Date.now()})`;
}

export function reconcile({ org, hook, log, cursor, run = gh, now = () => new Date() }) {
  let cursorState = { lastId: 0 };
  try {
    cursorState = JSON.parse(readFileSync(cursor, "utf8"));
  } catch {
    // First run: reconcile only what the log is missing, then set the cursor.
  }
  const raw = run(["api", `orgs/${org}/hooks/${hook}/deliveries?per_page=100`]);
  const deliveries = JSON.parse(raw);
  const logged = loggedDeliveryIds(log);
  const missing = deliveries.filter((d) => !logged.has(String(d.guid ?? d.id)));
  const failed = [];
  for (const delivery of missing) {
    try {
      run(["api", "-X", "POST", `orgs/${org}/hooks/${hook}/deliveries/${delivery.id}/attempts`]);
    } catch {
      failed.push(delivery);
    }
  }
  if (failed.length > 0) {
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, gapLine(failed) + "\n");
  }
  const newest = deliveries.reduce((max, d) => Math.max(max, Number(d.id) || 0), cursorState.lastId ?? 0);
  mkdirSync(dirname(cursor), { recursive: true });
  writeFileSync(cursor, JSON.stringify({ lastId: newest, at: now().toISOString() }), { mode: 0o600 });
  return { scanned: deliveries.length, missing: missing.length, redelivered: missing.length - failed.length, gaps: failed.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = reconcile(parseArgs(process.argv));
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
}

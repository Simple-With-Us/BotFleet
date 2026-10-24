#!/usr/bin/env node
/** Reconcile the GitHub request log against a hook's server-side delivery
 *  history.  If a delivery never landed in the log (the spool-write failure
 *  window: dispatch ACKed 200, so GitHub will not retry on its own), read the
 *  delivery's stored payload and append the metadata line DIRECTLY to the
 *  append-only Markdown log - never a GitHub redelivery, so no hook, existing
 *  or new, can re-dispatch a bot run.  Deliveries whose payload GitHub no
 *  longer retains (or whose read fails) get an explicit gap-marker line
 *  instead of silence.  All writes are append-only; the BotFleet server
 *  stays the only spool writer.
 *
 *  Usage: node scripts/github-request-log-reconcile.mjs \
 *    --org Simple-With-Us --hook <org-hook-id> \
 *    --log ~/.botfleet/github-request-log.md \
 *    --cursor ~/.botfleet/github-request-log.reconcile-cursor
 *
 *  Needs an admin:org_hook credential on `gh` (org hooks) or repo admin
 *  (repo hooks: pass --repo owner/name instead of --org). */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

export function parseArgs(argv) {
  const args = { org: undefined, repo: undefined, hook: undefined, log: undefined, cursor: undefined };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in args)) throw new Error(`unknown argument ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  if (!args.hook || !args.log || !args.cursor || (!args.org && !args.repo)) {
    throw new Error("missing --hook/--log/--cursor and one of --org/--repo");
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

/** Same metadata-only discipline as server/request-log.ts: never titles or bodies. */
export function extractMetadata(payload) {
  const meta = {};
  const source = payload && typeof payload === "object" ? payload : {};
  if (typeof source.action === "string" && source.action) meta.action = source.action.slice(0, 64);
  if (source.repository && typeof source.repository.full_name === "string") {
    meta.repository = source.repository.full_name.slice(0, 200);
  }
  if (source.sender && typeof source.sender.login === "string") meta.actor = source.sender.login.slice(0, 100);
  for (const key of ["pull_request", "issue", "discussion", "release", "check_run"]) {
    const entry = source[key];
    if (entry && typeof entry === "object" && typeof entry.number === "number") {
      meta.number = entry.number;
      break;
    }
  }
  return meta;
}

export function formatRecoveredLine({ ts, eventName, meta, deliveryId }) {
  const stamp = ts.toISOString().replace(/\.\d{3}Z$/, "Z");
  const action = meta.action ? `${eventName}.${meta.action}` : eventName;
  const target = (meta.repository ?? "") + (typeof meta.number === "number" ? `#${meta.number}` : "");
  const actor = meta.actor ? ` by ${meta.actor}` : "";
  return `- ${stamp} ${action}${target ? ` ${target}` : ""}${actor} [recovered] via github-request-log-reconcile (delivery ${deliveryId})`;
}

function gapLine(missing, now) {
  const stamp = now().toISOString().replace(/\.\d{3}Z$/, "Z");
  const ids = missing.map((d) => d.guid ?? d.id).join(", ");
  return `- ${stamp} reconcile [gap] via github-request-log-reconcile (${missing.length} deliver${missing.length === 1 ? "y" : "ies"} unrecoverable: ${ids}) (delivery gap-${now().getTime()})`;
}

export function reconcile({ org, repo, hook, log, cursor, run = gh, now = () => new Date() }) {
  const base = org ? `orgs/${org}` : `repos/${repo}`;
  let cursorState = { lastId: 0 };
  try {
    const parsed = JSON.parse(readFileSync(cursor, "utf8"));
    if (typeof parsed.lastId === "number") cursorState = parsed;
  } catch {
    // Missing or corrupt cursor: reconcile from the log, then rewrite the cursor.
  }
  const deliveries = JSON.parse(run(["api", `${base}/hooks/${hook}/deliveries?per_page=100`]));
  const logged = loggedDeliveryIds(log);
  const missing = deliveries.filter((d) => !logged.has(String(d.guid ?? d.id)));
  const failed = [];
  let recovered = 0;
  const lines = [];
  for (const delivery of missing) {
    try {
      const detail = JSON.parse(run(["api", `${base}/hooks/${hook}/deliveries/${delivery.id}`]));
      const payload = detail.request?.payload ?? detail.payload;
      if (!payload || typeof payload !== "object") throw new Error("payload not retained");
      const eventName = String(detail.event ?? delivery.event ?? "unknown").slice(0, 64);
      const deliveryId = String(delivery.guid ?? delivery.id);
      lines.push(
        formatRecoveredLine({
          ts: new Date(delivery.delivered_at ?? detail.delivered_at ?? now().toISOString()),
          eventName,
          meta: extractMetadata(payload),
          deliveryId,
        }),
      );
      recovered += 1;
    } catch {
      failed.push(delivery);
    }
  }
  if (lines.length > 0 || failed.length > 0) {
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, lines.map((line) => line + "\n").join(""));
    if (failed.length > 0) appendFileSync(log, gapLine(failed, now) + "\n");
  }
  const newest = deliveries.reduce((max, d) => Math.max(max, Number(d.id) || 0), cursorState.lastId ?? 0);
  mkdirSync(dirname(cursor), { recursive: true });
  writeFileSync(cursor, JSON.stringify({ lastId: newest, at: now().toISOString() }), { mode: 0o600 });
  return { scanned: deliveries.length, missing: missing.length, recovered, gaps: failed.length };
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

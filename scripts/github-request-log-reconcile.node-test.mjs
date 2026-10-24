import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractMetadata, formatRecoveredLine, loggedDeliveryIds, parseArgs, reconcile } from "./github-request-log-reconcile.mjs";

const dirs = [];
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const deliveries = [
  { id: 1003, guid: "g-1003", event: "pull_request", delivered_at: "2026-10-24T07:03:00Z" },
  { id: 1002, guid: "g-1002", event: "pull_request", delivered_at: "2026-10-24T07:02:00Z" },
  { id: 1001, guid: "g-1001", event: "pull_request", delivered_at: "2026-10-24T07:01:00Z" },
];

const payloadFor = {
  1002: { action: "synchronize", repository: { full_name: "Simple-With-Us/BotFleet" }, pull_request: { number: 1320, title: "title text must not leak" }, sender: { login: "kody-ai[bot]" } },
  1003: { action: "opened", repository: { full_name: "Simple-With-Us/BotFleet" }, pull_request: { number: 1321 }, sender: { login: "swu-echo[bot]" } },
};

function fakeRun(failOn = []) {
  const calls = [];
  return {
    calls,
    run: (args) => {
      const target = args.join(" ");
      calls.push(target);
      if (target.endsWith("deliveries?per_page=100")) return JSON.stringify(deliveries);
      const match = target.match(/deliveries\/(\d+)$/);
      if (match) {
        if (failOn.includes(Number(match[1]))) throw new Error("404");
        const payload = payloadFor[match[1]];
        if (!payload) throw new Error("410 Gone");
        return JSON.stringify({ id: Number(match[1]), event: "pull_request", request: { payload } });
      }
      throw new Error(`unexpected call: ${target}`);
    },
  };
}

function paths(dir) {
  return { org: "Org", hook: "9", log: join(dir, "log.md"), cursor: join(dir, "cursor.json") };
}

describe("parseArgs", () => {
  it("requires hook, log, cursor and org or repo", () => {
    assert.throws(() => parseArgs(["node", "x", "--org", "O"]), /missing/);
    assert.deepEqual(parseArgs(["node", "x", "--repo", "o/r", "--hook", "1", "--log", "L", "--cursor", "C"]), {
      org: undefined,
      repo: "o/r",
      hook: "1",
      log: "L",
      cursor: "C",
    });
  });
});

describe("loggedDeliveryIds", () => {
  it("collects delivery ids from log lines", () => {
    const dir = tmp();
    const log = join(dir, "log.md");
    writeFileSync(log, "- ts pull_request.opened o/r#1 by bot [received] via hook (delivery g-1001)\n");
    assert.deepEqual([...loggedDeliveryIds(log)], ["g-1001"]);
  });
  it("returns an empty set when the log does not exist", () => {
    assert.equal(loggedDeliveryIds(join(tmp(), "nope.md")).size, 0);
  });
});

describe("extractMetadata", () => {
  it("keeps metadata only", () => {
    const meta = extractMetadata(payloadFor[1002]);
    assert.deepEqual(meta, { action: "synchronize", repository: "Simple-With-Us/BotFleet", number: 1320, actor: "kody-ai[bot]" });
    assert.ok(!("title" in meta));
  });
});

describe("reconcile", () => {
  it("recovers missing deliveries by reading payloads - never requests redelivery", () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.log, "- ts x [received] via hook (delivery g-1001)\n");
    const { run, calls } = fakeRun();
    const result = reconcile({ ...p, run });
    assert.deepEqual(result, { scanned: 3, missing: 2, recovered: 2, gaps: 0 });
    assert.ok(!calls.some((c) => c.includes("/attempts")), "no redelivery attempts");
    const text = readFileSync(p.log, "utf8");
    assert.match(text, /pull_request\.synchronize Simple-With-Us\/BotFleet#1320 by kody-ai\[bot\] \[recovered\] via github-request-log-reconcile \(delivery g-1002\)/);
    assert.match(text, /\(delivery g-1003\)/);
    assert.ok(!text.includes("title text must not leak"));
    const cursor = JSON.parse(readFileSync(p.cursor, "utf8"));
    assert.equal(cursor.lastId, 1003);
    // Idempotent: everything logged now, nothing re-appended.
    const before = readFileSync(p.log, "utf8");
    const second = reconcile({ ...p, run });
    assert.equal(second.missing, 0);
    assert.equal(readFileSync(p.log, "utf8"), before);
  });

  it("writes a gap-marker line when GitHub no longer retains the payload", () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.log, "- (delivery g-1001)\n- (delivery g-1002)\n");
    const { run } = fakeRun([1003]);
    const result = reconcile({ ...p, run });
    assert.equal(result.gaps, 1);
    assert.match(readFileSync(p.log, "utf8"), /\[gap\] via github-request-log-reconcile \(1 delivery unrecoverable: g-1003\)/);
  });

  it("tolerates a corrupt cursor and rewrites it", () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.log, "- (delivery g-1001)\n- (delivery g-1002)\n- (delivery g-1003)\n");
    writeFileSync(p.cursor, "{not json");
    const { run } = fakeRun();
    const result = reconcile({ ...p, run });
    assert.equal(result.missing, 0);
    assert.equal(JSON.parse(readFileSync(p.cursor, "utf8")).lastId, 1003);
  });
});

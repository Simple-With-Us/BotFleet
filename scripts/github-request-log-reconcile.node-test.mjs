import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loggedDeliveryIds, parseArgs, reconcile } from "./github-request-log-reconcile.mjs";

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
  { id: 1003, guid: "g-1003", status: "OK" },
  { id: 1002, guid: "g-1002", status: "OK" },
  { id: 1001, guid: "g-1001", status: "OK" },
];

function fakeRun(failOn = []) {
  const calls = [];
  return {
    calls,
    run: (args) => {
      calls.push(args.join(" "));
      const target = args.join(" ");
      if (failOn.some((id) => target.includes(`deliveries/${id}/attempts`))) throw new Error("404");
      if (target.includes("deliveries?")) return JSON.stringify(deliveries);
      return "";
    },
  };
}

function paths(dir) {
  return { org: "Org", hook: "9", log: join(dir, "log.md"), cursor: join(dir, "cursor.json") };
}

describe("parseArgs", () => {
  it("requires all four arguments", () => {
    assert.throws(() => parseArgs(["node", "x", "--org", "O"]), /missing --hook/);
    assert.deepEqual(parseArgs(["node", "x", "--org", "O", "--hook", "1", "--log", "L", "--cursor", "C"]), {
      org: "O",
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
    writeFileSync(log, "- ts pull_request.opened o/r#1 by bot [received] via hook (delivery g-1001)\n- ts other (delivery g-1002)\n");
    assert.deepEqual([...loggedDeliveryIds(log)].sort(), ["g-1001", "g-1002"]);
  });
  it("returns an empty set when the log does not exist", () => {
    assert.equal(loggedDeliveryIds(join(tmp(), "nope.md")).size, 0);
  });
});

describe("reconcile", () => {
  it("redelivers deliveries missing from the log and advances the cursor", () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.log, "- ts pull_request.opened o/r#1 by bot [received] via hook (delivery g-1001)\n");
    const { run, calls } = fakeRun();
    const result = reconcile({ ...p, run });
    assert.deepEqual(result, { scanned: 3, missing: 2, redelivered: 2, gaps: 0 });
    assert.ok(calls.some((c) => c === `api -X POST orgs/Org/hooks/9/deliveries/1002/attempts`));
    assert.ok(calls.some((c) => c === `api -X POST orgs/Org/hooks/9/deliveries/1003/attempts`));
    assert.ok(!calls.some((c) => c.includes("1001/attempts")));
    const cursor = JSON.parse(readFileSync(p.cursor, "utf8"));
    assert.equal(cursor.lastId, 1003);
    // Idempotent: a second pass with the deliveries now logged redelivers nothing.
    writeFileSync(p.log, "- (delivery g-1001)\n- (delivery g-1002)\n- (delivery g-1003)\n");
    const second = reconcile({ ...p, run });
    assert.equal(second.missing, 0);
  });

  it("writes a gap-marker line for failed redeliveries instead of staying silent", () => {
    const dir = tmp();
    const p = paths(dir);
    writeFileSync(p.log, "- (delivery g-1001)\n- (delivery g-1002)\n");
    const { run } = fakeRun([1003]);
    const result = reconcile({ ...p, run });
    assert.equal(result.gaps, 1);
    const text = readFileSync(p.log, "utf8");
    assert.match(text, /\[gap\] via github-request-log \(1 delivery unrecoverable: g-1003\)/);
  });
});

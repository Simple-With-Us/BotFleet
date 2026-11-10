// Run with:  node --test deploy/linux-server/start.node-test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const startSh = join(directory, "start.sh");

// A fake node that records every invocation's argv and no-ops, so the
// check-storage preflight passes and the server exec is observable.
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "botfleet-start-heap-"));
  const runtime = join(root, "runtime");
  const code = join(root, "code");
  mkdirSync(join(runtime, "bin"), { recursive: true });
  mkdirSync(join(runtime, "data"), { recursive: true });
  mkdirSync(join(runtime, "logs"), { recursive: true });
  mkdirSync(join(code, "server"), { recursive: true });
  writeFileSync(join(runtime, "bin", "check-storage.mjs"), "// fixture\n");
  writeFileSync(join(code, "server", "index.ts"), "// fixture\n");
  const fakeNode = join(root, "node");
  writeFileSync(fakeNode, "#!/bin/sh\n{ printf 'call\\n'; printf '%s\\n' \"$@\"; printf 'end\\n'; } >>\"$FAKE_NODE_CALLS\"\nexit 0\n");
  chmodSync(fakeNode, 0o755);
  return { root, runtime, code, fakeNode, callsFile: join(root, "calls.log") };
}

function runStart(fixture, heapValue) {
  const env = { ...process.env, FAKE_NODE_CALLS: fixture.callsFile };
  if (heapValue === undefined) delete env.BF_NODE_HEAP_MB;
  else env.BF_NODE_HEAP_MB = heapValue;
  const result = spawnSync("sh", [startSh, fixture.runtime, fixture.code, fixture.fakeNode], { encoding: "utf8", env });
  assert.equal(result.error, undefined);
  return result;
}

function readCalls(callsFile) {
  if (!existsSync(callsFile)) return [];
  const calls = [];
  let current = null;
  for (const line of readFileSync(callsFile, "utf8").split("\n")) {
    if (line === "call") current = [];
    else if (line === "end") {
      calls.push(current);
      current = null;
    } else if (current !== null) current.push(line);
  }
  return calls;
}

function withFixture(fn) {
  return () => {
    const fixture = makeFixture();
    try {
      fn(fixture);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  };
}

const hasHeapFlag = (call) => call.some((arg) => arg.startsWith("--max-old-space-size="));

test("start.sh pins the default V8 heap on the server exec only", { skip: process.platform === "win32" }, withFixture((fixture) => {
  const result = runStart(fixture);
  assert.equal(result.status, 0, result.stderr);
  const calls = readCalls(fixture.callsFile);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].some((arg) => arg.endsWith("check-storage.mjs")));
  assert.equal(hasHeapFlag(calls[0]), false);
  assert.ok(calls[1].includes("--max-old-space-size=6144"));
  assert.ok(calls[1].includes("--experimental-strip-types"));
  assert.ok(calls[1].includes(join(fixture.code, "server", "index.ts")));
  assert.ok(calls[1].includes("--require-data-volume"));
  assert.equal(existsSync(join(fixture.runtime, "logs", "server.log")), true);
}));

test("start.sh honors BF_NODE_HEAP_MB including its bounds", { skip: process.platform === "win32" }, withFixture((fixture) => {
  for (const value of ["512", "3072", "65536", "006144"]) {
    rmSync(fixture.callsFile, { force: true });
    const result = runStart(fixture, value);
    assert.equal(result.status, 0, result.stderr);
    const calls = readCalls(fixture.callsFile);
    assert.equal(calls.length, 2);
    const expected = `--max-old-space-size=${Number.parseInt(value, 10)}`;
    assert.ok(calls[1].includes(expected), `expected ${expected} in ${JSON.stringify(calls[1])}`);
  }
}));

test("start.sh rejects a bad heap with exit 2 before reaching the server", { skip: process.platform === "win32" }, withFixture((fixture) => {
  for (const value of ["abc", "0", "511", "65537", "1G", "3072 ", " 3072", "3.5", "-1024", "99999999999999999999999", "6144\n--evil"]) {
    rmSync(fixture.callsFile, { force: true });
    const result = runStart(fixture, value);
    assert.equal(result.status, 2, `BF_NODE_HEAP_MB=${JSON.stringify(value)}`);
    assert.match(result.stderr, /BF_NODE_HEAP_MB must be an integer 512\.\.65536/);
    for (const call of readCalls(fixture.callsFile)) {
      assert.equal(call.some((arg) => arg.endsWith("server/index.ts")), false);
    }
  }
}));

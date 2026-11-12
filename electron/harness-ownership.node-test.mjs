import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHarnessOwnership, harnessOwnerProof, readHarnessOwner, verifyHarnessOwnerProof } from "./harness-ownership.mjs";

function temp(t) {
  const root = mkdtempSync(join(tmpdir(), "bf-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a live owner remains exclusive even with an old timestamp or different port", (t) => {
  const root = temp(t);
  const owner = acquireHarnessOwnership(root, 8799);
  const file = join(root, "harness-owner.json");
  writeFileSync(file, JSON.stringify({ ...owner, at: 0 }));
  assert.throws(() => acquireHarnessOwnership(root, 18799), /already owned by a live harness/);
  assert.equal(readHarnessOwner(root).pid, process.pid);
});

test("data-root aliases share ownership, while isolated data roots are independent", (t) => {
  const root = temp(t);
  const alias = `${root}-alias`;
  symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rmSync(alias, { force: true }));
  acquireHarnessOwnership(root, 8799);
  assert.throws(() => acquireHarnessOwnership(alias, 18799), /already owned/);
  assert.equal(acquireHarnessOwnership(temp(t), 28799).port, 28799);
});

test("a corrupt ownership record fails closed without disclosing its contents", (t) => {
  const root = temp(t);
  writeFileSync(join(root, "harness-owner.json"), '{"nonce":"private-value",BROKEN');
  assert.throws(() => acquireHarnessOwnership(root, 8799), (error) =>
    /ownership record is invalid/.test(error.message) && !error.message.includes("private-value"));
});

test("owner proof requires the data-root nonce and a fresh valid challenge", (t) => {
  const owner = acquireHarnessOwnership(temp(t), 8799);
  const challenge = "a".repeat(64);
  const proof = harnessOwnerProof(owner, challenge);
  assert.ok(verifyHarnessOwnerProof(owner, challenge, proof));
  assert.equal(verifyHarnessOwnerProof(owner, "b".repeat(64), proof), false);
  assert.equal(verifyHarnessOwnerProof({ ...owner, nonce: "c".repeat(64) }, challenge, proof), false);
  assert.equal(harnessOwnerProof(owner, "bad"), undefined);
  assert.equal(harnessOwnerProof(owner, [challenge]), undefined);
});

test("concurrent processes elect one owner and recover after its death", async (t) => {
  const root = temp(t);
  const moduleUrl = new URL("./harness-ownership.mjs", import.meta.url).href;
  const script = `import { acquireHarnessOwnership } from ${JSON.stringify(moduleUrl)};
    try { acquireHarnessOwnership(process.argv[1], Number(process.argv[2])); process.stdout.write('won'); setInterval(() => {}, 1000); }
    catch { process.exit(17); }`;
  const children = [8799, 18799, 28799].map((port) => spawn(process.execPath,
    ["--input-type=module", "-e", script, root, String(port)], { stdio: ["ignore", "pipe", "pipe"] }));
  t.after(() => children.forEach((child) => child.kill()));
  const outcomes = await Promise.all(children.map((child) => Promise.race([
    once(child.stdout, "data").then(() => "won"), once(child, "exit").then(([code]) => code),
  ])));
  assert.equal(outcomes.filter((v) => v === "won").length, 1);
  assert.equal(outcomes.filter((v) => v === 17).length, 2);
  const winner = children[outcomes.indexOf("won")];
  const exit = once(winner, "exit");
  winner.kill("SIGKILL");
  await exit;
  assert.equal(readHarnessOwner(root), null);
  const recovered = acquireHarnessOwnership(root, 37999);
  assert.equal(recovered.pid, process.pid);
  assert.equal(JSON.parse(readFileSync(join(root, "harness-owner.json"), "utf8")).port, 37999);
});

test("concurrent first starts serialize legacy migration before electing an owner", async (t) => {
  const root = temp(t);
  const legacy = join(root, "legacy");
  const current = join(root, "current");
  mkdirSync(legacy);
  writeFileSync(join(legacy, "fleet.txt"), "preserved");
  const moduleUrl = new URL("./harness-ownership.mjs", import.meta.url).href;
  const script = `import { initializeHarnessOwnership } from ${JSON.stringify(moduleUrl)};
    import { existsSync, renameSync } from 'node:fs';
    try {
      initializeHarnessOwnership(process.argv[1], 8799, () => {
        if (!existsSync(process.argv[1])) renameSync(process.argv[2], process.argv[1]);
      });
      process.stdout.write('won'); setInterval(() => {}, 1000);
    } catch { process.exit(17); }`;
  const children = [1, 2, 3].map(() => spawn(process.execPath,
    ["--input-type=module", "-e", script, `${current}/`, legacy], { stdio: ["ignore", "pipe", "pipe"] }));
  t.after(() => children.forEach((child) => child.kill()));
  const outcomes = await Promise.all(children.map((child) => Promise.race([
    once(child.stdout, "data").then(() => "won"), once(child, "exit").then(([code]) => code),
  ])));
  assert.deepEqual(outcomes.sort(), [17, 17, "won"]);
  assert.equal(existsSync(legacy), false);
  assert.equal(readFileSync(join(current, "fleet.txt"), "utf8"), "preserved");
  const winner = children.find((child) => child.exitCode === null);
  const exited = once(winner, "exit");
  winner.kill();
  await exited;
});

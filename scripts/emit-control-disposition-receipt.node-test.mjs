/* oxlint-disable eslint/no-irregular-whitespace -- Owner-required NBSP sentence gaps occur only in prose comments in this script. */
// The `control-disposition` receipt had no producer (BF-2701).
//
// The decommission gate needs it before `mac-control/` may be retired, and the
// tree had emitters for seven receipt kinds and not this one.  These tests
// cover the two halves of its producer: what the check measures against a
// commit, and what the emitter accepts, refuses, and leaves unwritten.
//
// Everything here is isolated.  The checkout is a temporary repository holding a
// synthetic tree, the capture is a temporary private directory, the bundle
// request and the attestation are fixtures, and nothing touches a real
// checkout, a real data directory, a launchd job or a network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONTROL_DISPOSITION_VERDICT_KIND, FLEET_ADMIN_ITEMS, PRODUCT_CONTROLS, RULING, checkControlDisposition,
  parseCliArgs as parseCheckCliArgs, summarizeControlDisposition,
} from "./check-control-disposition.mjs";
import { REQUIRED_RECEIPTS, checkFinalEvidenceBundle, evidenceHash } from "./decommission-evidence-bundle.mjs";
import {
  CONTROL_DISPOSITION_ARTIFACTS, CONTROL_DISPOSITION_CHECKS, CONTROL_DISPOSITION_RECEIPT_FILE,
  buildChecks, emitControlDispositionReceipt, parseCliArgs,
} from "./emit-control-disposition-receipt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK_SCRIPT = join(HERE, "check-control-disposition.mjs");
const EMIT_SCRIPT = join(HERE, "emit-control-disposition-receipt.mjs");

/** A private-key block, assembled from parts so the relay's secret scan reads
 * this file clean. It is a fixture and never leaves the test. */
const FIXTURE_BLOCK_BEGIN = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
const FIXTURE_BLOCK_END = ['-----END ', 'PRIVATE KEY-----'].join('');
const FIXTURE_CREDENTIAL = `${FIXTURE_BLOCK_BEGIN}\nnot-a-real-key-but-long-enough-to-be-masked\n${FIXTURE_BLOCK_END}\n`;

const BUILD = "202611240101";
const ACCEPTANCE_OWNER = "Fixture Owner";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A tree that carries the ruling and every control the ruling moved into the native app. */
function fixtureTree() {
  const files = new Map();
  files.set(RULING.document, [
    `# What BotFleet Control becomes after Node`,
    `Among the options offered is ${RULING.decision}.`,
    `The ruling was relayed as Zulip ${RULING.needles.at(-1)}.`,
    "",
  ].join("\n"));
  let index = 0;
  for (const control of PRODUCT_CONTROLS) {
    for (const { under, needle } of control.requirements) {
      const path = `${under}/Fixture${index += 1}.swift`;
      files.set(path, `${files.get(path) ?? ""}// carries ${needle}\n`);
    }
  }
  return files;
}

/** The fixture file that carries one requirement's needle. */
function fixtureFileFor(controlId, needle) {
  const control = PRODUCT_CONTROLS.find((entry) => entry.id === controlId);
  assert.ok(control, `no control named ${controlId}`);
  assert.ok(control.requirements.some((need) => need.needle === needle), `${controlId} has no requirement for ${needle}`);
  let index = 0;
  for (const entry of PRODUCT_CONTROLS) {
    for (const need of entry.requirements) {
      index += 1;
      if (entry.id === controlId && need.needle === needle) return `${need.under}/Fixture${index}.swift`;
    }
  }
  throw new Error("unreachable");
}

/** A git checkout holding a fixture tree, committed once. */
function checkout(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "bf-control-disposition-"));
  const files = fixtureTree();
  mutate(files);
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const git = (...args) => execFileSync(
    "git",
    ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture tree");
  return { root, git, head: git("rev-parse", "HEAD") };
}

/** A private capture directory with the files the producers read. */
function capture(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "bf-control-disposition-capture-"));
  chmodSync(root, 0o700);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content, { mode: 0o600 });
  }
  return root;
}

/** A bundle request the producer accepts, bound to a commit. */
function request(sourceSha, overrides = {}) {
  return {
    version: 1,
    candidate: { sourceSha, build: BUILD, artifactSha256: "b".repeat(64) },
    mode: "serverFirst",
    hosts: [
      { id: "mac:11111111-2222-3333-4444-555555555555", role: "mac" },
      { id: "server:66666666-7777-8888-9999-aaaaaaaaaaaa", role: "server" },
    ],
    acceptanceOwner: ACCEPTANCE_OWNER,
    engines: ["claude"],
    state: { path: "state.json", sha256: "c".repeat(64) },
    receipts: {},
    ...overrides,
  };
}

/** The provenance the producer is given. */
const PROVENANCE = Object.freeze({
  by: "Fixture Reviewer",
  at: "2026-11-23T06:00:00.000Z",
  source: "https://example.invalid/fixture",
  record: "provenance.txt",
});

/** The owner's attestation of the fleet-administration half. */
function attestation(overrides = {}) {
  return {
    version: 1,
    decision: "The fleet administration moved out of the BotFleet product.",
    items: FLEET_ADMIN_ITEMS.map(({ id }) => ({ id, disposition: "Muster", evidence: "https://example.invalid/muster" })),
    attestedBy: ACCEPTANCE_OWNER,
    attestedAt: "2026-11-24T02:00:00.000Z",
    source: "https://example.invalid/attestation",
    ...overrides,
  };
}

/**
 * A checkout, a real verdict from the check, a capture directory and a bundle
 * request, all bound to the same commit.
 */
function scenario({ tree = () => {}, attestation: attested = {}, verdict: judged = () => {}, candidate } = {}) {
  const repo = checkout(tree);
  const verdict = checkControlDisposition({ source: repo.root, commit: "HEAD" });
  judged(verdict);
  const root = capture({ "provenance.txt": "recorded by the fixture reviewer\n" });
  const verdictPath = join(root, "verdict.json");
  const attestationPath = join(root, "attestation.json");
  writeFileSync(verdictPath, JSON.stringify(verdict), { mode: 0o600 });
  writeFileSync(attestationPath, JSON.stringify(attestation(attested)), { mode: 0o600 });
  const bundle = request(candidate ?? repo.head);
  return {
    repo, root, verdict, verdictPath, attestationPath, request: bundle,
    emit: () => emitControlDispositionReceipt({
      captureDir: root, request: bundle, verdictPath, attestationPath, provenance: PROVENANCE,
    }),
    clean: () => {
      rmSync(repo.root, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The files a refusal must not leave behind. */
const OUTPUTS = [CONTROL_DISPOSITION_RECEIPT_FILE, ...Object.values(CONTROL_DISPOSITION_ARTIFACTS)];

function assertNothingWritten(root) {
  const left = readdirSync(root).filter((name) => OUTPUTS.includes(name));
  assert.deepEqual(left, [], `a refusal left ${left.join(", ")} behind`);
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

/** Ask the gate's own validator about a bundle request that cites only this receipt. */
function gateVerdict(root, reference, sourceSha) {
  const stateBytes = Buffer.from('{"issues":{},"evidence":{}}\n');
  writeFileSync(join(root, "state.json"), stateBytes, { mode: 0o600 });
  writeFileSync(join(root, "bundle.json"), `${JSON.stringify(
    request(sourceSha, { state: { path: "state.json", sha256: evidenceHash(stateBytes) }, receipts: { "control-disposition": reference } }),
    null,
    2,
  )}\n`, { mode: 0o600 });
  return checkFinalEvidenceBundle(join(root, "bundle.json"), {
    statePath: join(root, "state.json"),
    stateBytes,
    candidate: { sourceSha, build: BUILD, artifactSha256: "b".repeat(64) },
  });
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

test("the check passes a tree that carries the ruling and every control", () => {
  const repo = checkout();
  try {
    const verdict = checkControlDisposition({ source: repo.root, commit: "HEAD" });
    assert.equal(verdict.kind, CONTROL_DISPOSITION_VERDICT_KIND);
    assert.equal(verdict.sourceSha, repo.head);
    assert.equal(verdict.ruling.found, true);
    assert.equal(verdict.ruling.decision, RULING.decision);
    assert.equal(verdict.controls.length, PRODUCT_CONTROLS.length);
    assert.ok(verdict.controls.every((control) => control.landed && control.missing.length === 0));
    assert.deepEqual(verdict.checks, {
      "owner-decision": { ok: true, exitCode: 0 },
      "landed-implementation": { ok: true, exitCode: 0 },
    });
    //  The attestation is not measurable, so the verdict says nothing of it.
    assert.equal("muster-disposition" in verdict.checks, false);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("the check names the control whose marker is missing, and nothing else", () => {
  const repo = checkout((files) => {
    const path = fixtureFileFor("fenced-start", "startServerAndSettle");
    files.set(path, "// a screen with no start behind it\n");
  });
  try {
    const verdict = checkControlDisposition({ source: repo.root, commit: "HEAD" });
    assert.deepEqual(verdict.checks["owner-decision"], { ok: true, exitCode: 0 });
    assert.deepEqual(verdict.checks["landed-implementation"], { ok: false, exitCode: 1 });
    const failed = verdict.controls.filter((control) => !control.landed);
    assert.deepEqual(failed.map((control) => control.id), ["fenced-start"]);
    assert.equal(failed[0].missing.length, 1);
    assert.match(failed[0].missing[0], /"ios\/MacApp" carries startServerAndSettle/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("the check fails the ruling when its record is gone from the document", () => {
  const repo = checkout((files) => {
    files.set(RULING.document, `# What BotFleet Control becomes after Node\nAmong the options offered is ${RULING.decision}.\n`);
  });
  try {
    const verdict = checkControlDisposition({ source: repo.root, commit: "HEAD" });
    //  The option's name is still there, in the list of options.  The message
    //  the ruling was relayed as is what tells the ruling from the question.
    assert.equal(verdict.ruling.found, false);
    assert.deepEqual(verdict.ruling.missing, [`nothing under "${RULING.document}" carries ${RULING.needles.at(-1)}`]);
    assert.deepEqual(verdict.checks["owner-decision"], { ok: false, exitCode: 1 });
    assert.deepEqual(verdict.checks["landed-implementation"], { ok: true, exitCode: 0 });
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("the check reads the commit and never the working tree", () => {
  const repo = checkout((files) => {
    files.delete(fixtureFileFor("saved-servers-import", "control-hosts.json"));
  });
  try {
    const importPath = fixtureFileFor("saved-servers-import", "control-hosts.json");
    //  A marker that exists only as an uncommitted edit is not in the commit.
    mkdirSync(dirname(join(repo.root, importPath)), { recursive: true });
    writeFileSync(join(repo.root, importPath), "// carries control-hosts.json\n");
    //  A marker deleted from the working tree is still in the commit.  The
    //  one deleted here is the app's own:  needles are matched as substrings,
    //  so the status route's would still be carried by the VM routes' markers.
    const committed = fixtureFileFor("harness-status", "controlStatus");
    rmSync(join(repo.root, committed));
    const before = checkControlDisposition({ source: repo.root, commit: "HEAD" });
    assert.equal(before.controls.find((control) => control.id === "saved-servers-import").landed, false);
    assert.equal(before.controls.find((control) => control.id === "harness-status").landed, true);

    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "add the import, drop a status marker");
    const after = checkControlDisposition({ source: repo.root, commit: "HEAD" });
    assert.equal(after.sourceSha, repo.git("rev-parse", "HEAD"));
    assert.equal(after.controls.find((control) => control.id === "saved-servers-import").landed, true);
    assert.equal(after.controls.find((control) => control.id === "harness-status").landed, false);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("an abbreviated commit is resolved to the identifier the candidate carries", () => {
  const repo = checkout();
  try {
    for (const named of ["HEAD", repo.head.slice(0, 7), repo.head.slice(0, 12)]) {
      assert.equal(checkControlDisposition({ source: repo.root, commit: named }).sourceSha, repo.head);
    }
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a commit the checkout does not have is refused rather than read as an empty tree", () => {
  const repo = checkout();
  try {
    assert.throws(
      () => checkControlDisposition({ source: repo.root, commit: "f".repeat(40) }),
      /the commit could not be resolved/,
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("the verdict's summary follows from its own details, and changes when they do", () => {
  const repo = checkout();
  try {
    const verdict = checkControlDisposition({ source: repo.root, commit: "HEAD" });
    assert.deepEqual(summarizeControlDisposition(verdict), verdict.checks);
    //  One control not landed is enough to fail the implementation, however
    //  many of the others are.
    const first = verdict.controls[0];
    const regressed = {
      ...verdict,
      controls: verdict.controls.map((control) => (control.id === first.id ? { ...control, landed: false, missing: ["gone"] } : control)),
    };
    assert.deepEqual(summarizeControlDisposition(regressed), {
      "owner-decision": { ok: true, exitCode: 0 },
      "landed-implementation": { ok: false, exitCode: 1 },
    });
    //  A verdict that lists fewer controls than the ruling names passes
    //  nothing, even when every one it lists landed.
    const partial = { ...verdict, controls: verdict.controls.slice(1) };
    assert.equal(summarizeControlDisposition(partial)["landed-implementation"].ok, false);
    //  A summary that says landed beside a detail that says not is the
    //  summary that loses.
    const contradicted = { ...verdict, ruling: { ...verdict.ruling, found: false } };
    assert.equal(summarizeControlDisposition(contradicted)["owner-decision"].ok, false);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("the check's command prints the verdict, writes it owner-only and exits by what it found", () => {
  const repo = checkout((files) => {
    files.delete(fixtureFileFor("fenced-start", '"kickstart"'));
  });
  const out = join(mkdtempSync(join(tmpdir(), "bf-control-disposition-out-")), "verdict.json");
  try {
    const passing = spawnSync(process.execPath, [CHECK_SCRIPT, "--source", repo.root, "--commit", "HEAD", "--out", out]);
    assert.equal(passing.status, 1, passing.stderr.toString());
    const printed = JSON.parse(passing.stdout.toString());
    assert.equal(printed.checks["landed-implementation"].exitCode, 1);
    assert.equal(printed.sourceSha, repo.head);
    assert.equal(readFileSync(out, "utf8"), `${JSON.stringify(printed, null, 2)}\n`);
    assert.equal(mode(out), 0o600);

    const complete = checkout();
    try {
      const held = spawnSync(process.execPath, [CHECK_SCRIPT, "--source", complete.root, "--commit", "HEAD"]);
      assert.equal(held.status, 0, held.stderr.toString());
      assert.equal(JSON.parse(held.stdout.toString()).checks["owner-decision"].ok, true);
    } finally {
      rmSync(complete.root, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
    rmSync(dirname(out), { recursive: true, force: true });
  }
});

test("both commands refuse an unknown flag, a repeated flag and a missing one", () => {
  //  The emitter needs all eight of its flags.
  assert.throws(() => parseCliArgs(["--capture", "x"]), /--request, --verdict, --attestation, --provenance-record, --provenance-source, --provenance-by, --provenance-at are required/);
  assert.throws(() => parseCliArgs([
    "--capture", "a", "--capture", "b", "--request", "r", "--verdict", "v", "--attestation", "t",
    "--provenance-record", "p", "--provenance-source", "s", "--provenance-by", "b", "--provenance-at", "a",
  ]), /duplicate flag: --capture/);
  assert.throws(() => parseCliArgs(["--unknown"]), /unknown argument: --unknown/);
  assert.throws(() => parseCliArgs(["--capture", "--request"]), /missing value for --capture/);

  //  The check needs its checkout and its commit.  Its output file is optional.
  assert.throws(() => parseCheckCliArgs(["--source", "x"]), /--commit is required/);
  assert.throws(() => parseCheckCliArgs(["--out", "o"]), /--source, --commit are required/);
  assert.throws(() => parseCheckCliArgs(["--source", "a", "--source", "b", "--commit", "c"]), /duplicate flag: --source/);
  assert.throws(() => parseCheckCliArgs(["--unknown"]), /unknown argument: --unknown/);
  assert.throws(() => parseCheckCliArgs(["--source", "--commit", "c"]), /missing value for --source/);
  assert.deepEqual(parseCheckCliArgs(["--source", "a", "--commit", "c", "--out", "o"]), new Map([
    ["--source", "a"], ["--commit", "c"], ["--out", "o"],
  ]));
});

// ---------------------------------------------------------------------------
// The emitter
// ---------------------------------------------------------------------------

test("the producer writes a receipt from a passing verdict and a complete attestation", () => {
  const scene = scenario();
  try {
    const result = scene.emit();
    assert.equal(result.kind, "control-disposition");
    assert.equal(result.receipt.candidate.sourceSha, scene.repo.head);
    assert.deepEqual(result.receipt.data.checks.map((check) => check.name), CONTROL_DISPOSITION_CHECKS);
    for (const check of result.receipt.data.checks) {
      assert.equal(check.exitCode, 0);
      assert.equal(check.artifact.path, CONTROL_DISPOSITION_ARTIFACTS[check.name]);
      assert.equal(check.artifact.sha256, evidenceHash(readFileSync(join(scene.root, check.artifact.path))));
      assert.equal(mode(join(scene.root, check.artifact.path)), 0o600);
    }
    //  The artifacts say what was judged, and name the commit it was judged at.
    const landed = JSON.parse(readFileSync(join(scene.root, CONTROL_DISPOSITION_ARTIFACTS["landed-implementation"]), "utf8"));
    assert.equal(landed.sourceSha, scene.repo.head);
    assert.deepEqual(landed.controls, scene.verdict.controls);
    const muster = JSON.parse(readFileSync(join(scene.root, CONTROL_DISPOSITION_ARTIFACTS["muster-disposition"]), "utf8"));
    assert.deepEqual(muster.items.map((item) => item.id), FLEET_ADMIN_ITEMS.map((item) => item.id));
    assert.equal(muster.attestedBy, ACCEPTANCE_OWNER);
    //  The receipt is written into the capture directory, owner-only.
    const written = join(scene.root, CONTROL_DISPOSITION_RECEIPT_FILE);
    assert.equal(mode(written), 0o600);
    assert.equal(readFileSync(written, "utf8"), `${JSON.stringify(result.receipt, null, 2)}\n`);
  } finally {
    scene.clean();
  }
});

test("the gate's own validator accepts the emitted receipt, and refuses a tampered one", () => {
  const scene = scenario();
  try {
    const result = scene.emit();
    const accepted = gateVerdict(scene.root, result.reference, scene.repo.head);
    //  Every other receipt is absent here, which shows the validator ran.
    //  Nothing is held against this one.
    assert.equal(accepted.blockers.length, REQUIRED_RECEIPTS.length - 1, accepted.blockers.join("\n"));
    assert.ok(accepted.blockers.every((blocker) => blocker.endsWith(": missing-receipt")), accepted.blockers.join("\n"));
    assert.equal(accepted.blockers.some((blocker) => blocker.startsWith("control-disposition:")), false);

    const receiptPath = join(scene.root, CONTROL_DISPOSITION_RECEIPT_FILE);
    const tampered = JSON.parse(readFileSync(receiptPath, "utf8"));
    tampered.data.checks[0].exitCode = 1;
    writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    const failedCheck = gateVerdict(scene.root, {
      path: CONTROL_DISPOSITION_RECEIPT_FILE,
      sha256: evidenceHash(readFileSync(receiptPath)),
    }, scene.repo.head);
    assert.ok(failedCheck.blockers.includes("control-disposition: command-did-not-pass"), failedCheck.blockers.join("\n"));

    //  Put the receipt back, and change one byte of an artifact it cites.
    writeFileSync(receiptPath, `${JSON.stringify(result.receipt, null, 2)}\n`, { mode: 0o600 });
    const artifact = join(scene.root, CONTROL_DISPOSITION_ARTIFACTS["owner-decision"]);
    writeFileSync(artifact, `${readFileSync(artifact, "utf8")} `, { mode: 0o600 });
    const moved = gateVerdict(scene.root, result.reference, scene.repo.head);
    assert.ok(moved.blockers.includes("control-disposition: evidence-hash-mismatch"), moved.blockers.join("\n"));
  } finally {
    scene.clean();
  }
});


test("a verdict taken against another commit than the candidate is refused", () => {
  const scene = scenario({ candidate: "a".repeat(40) });
  try {
    assert.throws(() => scene.emit(), /the verdict was taken against [0-9a-f]{40}, and the bundle's candidate is a{40}/);
    assertNothingWritten(scene.root);
  } finally {
    scene.clean();
  }
});

test("a verdict whose summary contradicts its own details did not come from the check and is refused", () => {
  const scene = scenario({
    verdict: (verdict) => {
      verdict.controls = verdict.controls.map((control) => (
        control.id === "saved-servers-import" ? { ...control, landed: false, missing: ["says so here"] } : control
      ));
    },
  });
  try {
    assert.throws(() => scene.emit(), /the verdict's summary for landed-implementation does not follow from its own details/);
    assertNothingWritten(scene.root);
  } finally {
    scene.clean();
  }
});

test("a verdict that leaves a control out, names one the ruling does not, or is about another ruling is refused", () => {
  const leftOut = scenario({ verdict: (verdict) => { verdict.controls.pop(); } });
  try {
    assert.throws(() => leftOut.emit(), /the verdict says nothing about the controls: lifecycle-surface/);
    assertNothingWritten(leftOut.root);
  } finally {
    leftOut.clean();
  }
  const invented = scenario({
    verdict: (verdict) => { verdict.controls.push({ id: "teleport", label: "Teleport", landed: true, missing: [] }); },
  });
  try {
    assert.throws(() => invented.emit(), /the verdict names a control the ruling does not: teleport/);
    assertNothingWritten(invented.root);
  } finally {
    invented.clean();
  }
  const relabelled = scenario({
    verdict: (verdict) => { verdict.controls[0].label = "Something else altogether"; },
  });
  try {
    assert.throws(() => relabelled.emit(), /under another label/);
    assertNothingWritten(relabelled.root);
  } finally {
    relabelled.clean();
  }
  const otherRuling = scenario({
    verdict: (verdict) => { verdict.ruling.document = "docs/plans/some-other-decision.md"; },
  });
  try {
    assert.throws(() => otherRuling.emit(), /not about the ruling that split BotFleet Control/);
    assertNothingWritten(otherRuling.root);
  } finally {
    otherRuling.clean();
  }
});

test("nothing is written while the ruling is not recorded or a control is not landed", () => {
  const notLanded = scenario({
    tree: (files) => { files.delete(fixtureFileFor("saved-servers-import", "control-hosts.json")); },
  });
  try {
    assert.throws(
      () => notLanded.emit(),
      /nothing was written, because landed-implementation does not hold, saved-servers-import: nothing under "ios\/Sources\/CompanionCore" carries control-hosts\.json\./,
    );
    assertNothingWritten(notLanded.root);
  } finally {
    notLanded.clean();
  }
  const notRuled = scenario({
    tree: (files) => { files.delete(RULING.document); },
  });
  try {
    assert.throws(
      () => notRuled.emit(),
      /nothing was written, because owner-decision does not hold: nothing under "[^"]+" carries Option C; nothing under "[^"]+" carries 636105146\./,
    );
    assertNothingWritten(notRuled.root);
  } finally {
    notRuled.clean();
  }
});

test("an attestation that is silent about an item of the half is refused, and the item is named", () => {
  const [silent] = FLEET_ADMIN_ITEMS.slice(2, 3);
  const scene = scenario({ attestation: { items: attestation().items.filter((item) => item.id !== silent.id) } });
  try {
    assert.throws(() => scene.emit(), new RegExp(`nothing is said about: ${silent.label}\\.?`));
    assertNothingWritten(scene.root);
  } finally {
    scene.clean();
  }
});

test("an attestation that names an item the ruling does not move out is refused", () => {
  const scene = scenario({
    attestation: { items: [...attestation().items, { id: "the-servers-list", disposition: "Nowhere", evidence: "https://example.invalid/x" }] },
  });
  try {
    assert.throws(() => scene.emit(), /names an item the ruling does not move out of the product: the-servers-list/);
    assertNothingWritten(scene.root);
  } finally {
    scene.clean();
  }
});

test("an attestation by anyone but the bundle's acceptance owner is refused", () => {
  const scene = scenario({ attestation: { attestedBy: "A Seat That Is Not The Owner" } });
  try {
    assert.throws(() => scene.emit(), /attested by A Seat That Is Not The Owner, and the bundle's acceptance owner is Fixture Owner/);
    assertNothingWritten(scene.root);
  } finally {
    scene.clean();
  }
});

test("an attestation that is malformed is refused as such, before any check is read", () => {
  const cases = [
    [{ items: attestation().items.map((item) => ({ ...item, evidence: "http://example.invalid/plain" })) }, /evidence|https|url/i],
    [{ items: [...attestation().items, attestation().items[0]] }, /more than once/],
    [{ attestedAt: "2026-11-24 02:00:00" }, /attestedAt/],
    [{ decision: "   " }, /decision/],
    [{ version: 2 }, /version/],
  ];
  for (const [override, expected] of cases) {
    const scene = scenario({ attestation: override });
    try {
      assert.throws(() => scene.emit(), expected);
      assertNothingWritten(scene.root);
    } finally {
      scene.clean();
    }
  }
});

test("an attestation that holds a credential is refused before anything is written", () => {
  const scene = scenario({ attestation: { decision: `Decided. ${FIXTURE_CREDENTIAL}` } });
  try {
    assert.throws(() => scene.emit(), /muster-disposition artifact contains unredacted credentials, so nothing was written/);
    assertNothingWritten(scene.root);
  } finally {
    scene.clean();
  }
});

test("a capture directory other people can read, and a provenance record that is not there, are refused", () => {
  const scene = scenario();
  try {
    chmodSync(scene.root, 0o755);
    assert.throws(() => scene.emit(), /is not private \(mode 755\)/);
    chmodSync(scene.root, 0o700);
    assert.throws(
      () => emitControlDispositionReceipt({
        captureDir: scene.root, request: scene.request, verdictPath: scene.verdictPath,
        attestationPath: scene.attestationPath, provenance: { ...PROVENANCE, record: "missing.txt" },
      }),
      /missing-file|could not be read|no such/i,
    );
    assertNothingWritten(scene.root);
  } finally {
    scene.clean();
  }
});

test("a refusal leaves a receipt from an earlier good run as it was", () => {
  const scene = scenario();
  try {
    const first = scene.emit();
    const receiptPath = join(scene.root, CONTROL_DISPOSITION_RECEIPT_FILE);
    const before = readFileSync(receiptPath);
    assert.throws(
      () => emitControlDispositionReceipt({
        captureDir: scene.root, request: scene.request, verdictPath: scene.verdictPath,
        attestationPath: scene.attestationPath,
        provenance: { ...PROVENANCE, source: "http://example.invalid/plain" },
      }),
      /the provenance source must be an https URL/,
    );
    assert.ok(readFileSync(receiptPath).equals(before));
    assert.equal(evidenceHash(readFileSync(receiptPath)), first.reference.sha256);
  } finally {
    scene.clean();
  }
});

test("an unwritable receipt path is refused before any artifact an earlier run wrote is replaced", () => {
  const scene = scenario();
  try {
    const first = scene.emit();
    const receiptPath = join(scene.root, CONTROL_DISPOSITION_RECEIPT_FILE);
    const ownerDecision = join(scene.root, CONTROL_DISPOSITION_ARTIFACTS["owner-decision"]);
    const beforeReceipt = readFileSync(receiptPath);
    const beforeOwnerDecision = readFileSync(ownerDecision);

    //  A directory where the receipt belongs:  the preflight refuses it, and
    //  nothing an earlier good run left behind is touched on the way out.
    //  Without the preflight this would replace the three artifacts first and
    //  fail afterwards, leaving an earlier receipt citing bytes it never wrote.
    rmSync(receiptPath);
    mkdirSync(receiptPath);

    assert.throws(
      () => scene.emit(),
      /the receipt path is not a plain single-link file/,
    );
    assert.ok(readFileSync(ownerDecision).equals(beforeOwnerDecision),
      "the artifacts an earlier run wrote must not be replaced by a refusal");

    rmdirSync(receiptPath);
    writeFileSync(receiptPath, beforeReceipt, { mode: 0o600 });
    assert.equal(evidenceHash(readFileSync(receiptPath)), first.reference.sha256);
  } finally {
    scene.clean();
  }
});

test("a check the bundle starts to carry that this receipt has not is refused by name", () => {
  //  The trigger is the bundle's own check list changing, which no fixture
  //  can make in place, so the refusal is reachable as a pure function.  A
  //  TypeError inside the loop would have escaped every refusal and written
  //  nothing useful while reporting something unreadable.
  const stated = {
    "owner-decision": { ok: true, exitCode: 0 },
    "landed-implementation": { ok: true, exitCode: 0 },
  };
  const refs = {
    "owner-decision": { path: "a.json", sha256: "0".repeat(64) },
    "landed-implementation": { path: "b.json", sha256: "1".repeat(64) },
    "muster-disposition": { path: "c.json", sha256: "2".repeat(64) },
  };
  assert.throws(
    () => buildChecks([...CONTROL_DISPOSITION_CHECKS, "a-new-check"], stated, refs),
    /the bundle names a check this receipt does not have: a-new-check, so nothing was written/,
  );
  assert.throws(
    () => buildChecks(["a-renamed-check"], stated, refs),
    /does not have: a-renamed-check/,
  );
  //  The three the bundle does name still build, and the attestation's own
  //  check is the one that never comes from the verdict.
  const built = buildChecks(CONTROL_DISPOSITION_CHECKS, stated, refs);
  assert.equal(built.length, 3);
  assert.deepEqual(built.map((check) => check.name), [...CONTROL_DISPOSITION_CHECKS]);
  assert.equal(built.find((check) => check.name === "muster-disposition").exitCode, 0);
  assert.equal(built[0].exitCode, 0);
  //  A verdict that answers nothing, and a check with nothing staged, are
  //  their own refusals rather than an undefined read.
  assert.throws(() => buildChecks(CONTROL_DISPOSITION_CHECKS, {}, refs), /has no result for owner-decision/);
  const noArtifact = { ...refs };
  delete noArtifact["landed-implementation"];
  assert.throws(
    () => buildChecks(CONTROL_DISPOSITION_CHECKS, stated, noArtifact),
    /the landed-implementation artifact was not staged/,
  );
});

test("an artifact destination that cannot be replaced is refused before anything is written", () => {
  const scene = scenario();
  try {
    const first = scene.emit();
    const receiptPath = join(scene.root, CONTROL_DISPOSITION_RECEIPT_FILE);
    const beforeReceipt = readFileSync(receiptPath);
    const intact = CONTROL_DISPOSITION_ARTIFACTS["owner-decision"];
    const beforeIntact = readFileSync(join(scene.root, intact));

    //  A folder where one artifact belongs:  the preflight refuses it before
    //  the first artifact of this run is replaced, so the receipt and the
    //  other artifacts an earlier good run left are still the ones it cites.
    const blocked = CONTROL_DISPOSITION_ARTIFACTS["muster-disposition"];
    rmSync(join(scene.root, blocked));
    mkdirSync(join(scene.root, blocked));

    assert.throws(
      () => scene.emit(),
      /the .*artifact could not be replaced, so nothing was written/,
    );
    assert.ok(readFileSync(receiptPath).equals(beforeReceipt), "an earlier receipt must stand");
    assert.ok(readFileSync(join(scene.root, intact)).equals(beforeIntact), "the other artifacts must stand");

    rmdirSync(join(scene.root, blocked));
    const after = scene.emit();
    assert.equal(after.reference.sha256, first.reference.sha256, "a clean re-run reproduces the receipt");
  } finally {
    scene.clean();
  }
});

test("the producer's command writes the receipt and says what it wrote", () => {
  const scene = scenario();
  try {
    const run = spawnSync(process.execPath, [
      EMIT_SCRIPT,
      "--capture", scene.root,
      "--request", writeBundleRequest(scene),
      "--verdict", scene.verdictPath,
      "--attestation", scene.attestationPath,
      "--provenance-record", PROVENANCE.record,
      "--provenance-source", PROVENANCE.source,
      "--provenance-by", PROVENANCE.by,
      "--provenance-at", PROVENANCE.at,
    ]);
    assert.equal(run.status, 0, run.stderr.toString());
    const said = JSON.parse(run.stdout.toString());
    assert.equal(said.kind, "control-disposition");
    assert.deepEqual(said.receipts["control-disposition"].path, CONTROL_DISPOSITION_RECEIPT_FILE);

    const refused = spawnSync(process.execPath, [
      EMIT_SCRIPT, "--capture", scene.root, "--request", writeBundleRequest(scene, "a".repeat(40)),
      "--verdict", scene.verdictPath, "--attestation", scene.attestationPath,
      "--provenance-record", PROVENANCE.record, "--provenance-source", PROVENANCE.source,
      "--provenance-by", PROVENANCE.by, "--provenance-at", PROVENANCE.at,
    ]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr.toString(), /refused: the verdict was taken against/);
  } finally {
    scene.clean();
  }
});

/** Write a bundle request for the command-line producer, bound to a commit. */
function writeBundleRequest(scene, sourceSha = scene.repo.head) {
  const path = join(scene.root, "request.json");
  writeFileSync(path, `${JSON.stringify(request(sourceSha), null, 2)}\n`, { mode: 0o600 });
  return path;
}

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "scripts/ios-fleet/publish-ios-versions.sh");

const FLEET = {
  schemaVersion: 1,
  updatedAt: "2026-08-24T07:44:52Z",
  apps: {
    "com.socratictrade.ios": {
      displayName: "Socratic-Trade",
      marketingVersion: "1.0.68",
      appleId: 1111111111,
    },
    "trade.congress.ios": {
      displayName: "Congress.Trade",
      marketingVersion: "1.0.80",
      appleId: 1111111112,
    },
    "net.dealdex": {
      marketingVersion: "1.0.2",
      build: "202608230250",
      appleId: 1111111113,
      displayName: "DealDex",
    },
  },
};

function run(args, env = {}) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, FLEET_ICON_AUDIT: "off", ...env } });
}

function fixture(name, doc) {
  const dir = mkdtempSync(join(tmpdir(), name));
  const base = join(dir, "remote.json");
  const out = join(dir, "out.json");
  writeFileSync(base, JSON.stringify(doc, null, 2) + "\n");
  return { dir, base, out };
}

test("merge onto a multi-app remote keeps every sibling", () => {
  const { dir, base, out } = fixture("afc-ios-versions-", FLEET);
  const res = run([
    "--bundle-id",
    "com.socratictrade.ios",
    "--version",
    "1.0.69",
    "--build",
    "202608250045",
    "--apple-id",
    "1111111111",
    "--display-name",
    "Socratic-Trade",
    "--base-json",
    base,
    "--out-json",
    out,
    "--skip-push",
    "--skip-local-write",
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const merged = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(merged.apps).sort(), Object.keys(FLEET.apps).sort());
  assert.equal(merged.apps["com.socratictrade.ios"].marketingVersion, "1.0.69");
  assert.equal(merged.apps["com.socratictrade.ios"].build, "202608250045");
  assert.equal(merged.apps["net.dealdex"].marketingVersion, "1.0.2");
  assert.equal(merged.apps["trade.congress.ios"].marketingVersion, "1.0.80");
  rmSync(dir, { recursive: true, force: true });
});

test("empty base is refused so a missing local file cannot wipe the fleet", () => {
  const { dir, base, out } = fixture("afc-ios-versions-empty-", { schemaVersion: 1, apps: {} });
  const res = run([
    "--bundle-id",
    "com.socratictrade.ios",
    "--version",
    "1.0.69",
    "--base-json",
    base,
    "--out-json",
    out,
    "--skip-push",
    "--skip-local-write",
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no apps|refusing/i);
  rmSync(dir, { recursive: true, force: true });
});

test("the merge keeps the manifest's own schemaVersion", () => {
  const { dir, base, out } = fixture("afc-ios-versions-schema-", { ...FLEET, schemaVersion: 2 });
  const res = run(["--bundle-id", "com.socratictrade.ios", "--version", "1.0.69", "--base-json", base, "--out-json", out, "--skip-push", "--skip-local-write"]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).schemaVersion, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("a single-app base stays a single-app document", () => {
  const { dir, base, out } = fixture("afc-ios-versions-one-app-", {
    schemaVersion: 1,
    apps: { "com.socratictrade.ios": { marketingVersion: "1.0.68" } },
  });
  const res = run([
    "--bundle-id",
    "com.socratictrade.ios",
    "--version",
    "1.0.69",
    "--base-json",
    base,
    "--out-json",
    out,
    "--skip-push",
    "--skip-local-write",
  ]);
  // A single-app base is a one-app remote, so one app stays one app:  the
  // refusal is about the merged document shrinking a multi-app remote.
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const merged = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(merged.apps), ["com.socratictrade.ios"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a version and build the remote already records is a no-op", () => {
  const doc = JSON.parse(JSON.stringify(FLEET));
  doc.apps["com.socratictrade.ios"].build = "202608250045";
  const { dir, base } = fixture("afc-ios-versions-noop-", doc);
  const res = run(
    [
      "--bundle-id",
      "com.socratictrade.ios",
      "--version",
      "1.0.68",
      "--build",
      "202608250045",
      "--base-json",
      base,
      "--skip-local-write",
    ],
    { GH_TOKEN: "", GITHUB_TOKEN: "" },
  );
  // The check runs before the credential is resolved, so a ship with nothing
  // to publish needs no token, reaches no network, and leaves no pull request.
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /already recorded/);
  assert.doesNotMatch(res.stdout, /pull/);
  rmSync(dir, { recursive: true, force: true });
});

test("the same version with a new build is NOT a no-op", () => {
  const doc = JSON.parse(JSON.stringify(FLEET));
  doc.apps["com.socratictrade.ios"].build = "202608250045";
  const { dir, base } = fixture("afc-ios-versions-newbuild-", doc);
  const res = run(
    [
      "--bundle-id",
      "com.socratictrade.ios",
      "--version",
      "1.0.68",
      "--build",
      "202608259999",
      "--base-json",
      base,
      "--skip-local-write",
    ],
    { GH_TOKEN: "", GITHUB_TOKEN: "ghs_notarealtoken" },
  );
  // It got past the no-op check and reached the credential, which is refused.
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /GITHUB_TOKEN cannot write to/);
  rmSync(dir, { recursive: true, force: true });
});

test("the publish never writes to the default branch", () => {
  const src = readFileSync(SCRIPT, "utf8");
  // Every contents write names the publish branch, so no write can land on
  // the default branch:  a ruleset with required status checks refuses that.
  const putCount = (src.match(/--method PUT/g) || []).length;
  const branchCount = (src.match(/-f branch="\$\{PR_BRANCH\}"/g) || []).length;
  assert.ok(putCount >= 1, "the script writes the document with a contents PUT");
  assert.equal(putCount, branchCount, "every contents write names the publish branch");
  assert.match(src, /git\/refs\/heads\//);
  assert.match(src, /--method POST\s+"repos\/\$\{REPO\}\/pulls"/);
  assert.match(src, /repos\/\$\{REPO\}\/pulls\?head=/);
});

test("the publish refuses the workflow's own read-only GITHUB_TOKEN", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /GITHUB_TOKEN cannot write to/);
  const { dir, base } = fixture("afc-ios-versions-token-", FLEET);
  const res = run(
    ["--bundle-id", "com.socratictrade.ios", "--version", "1.0.69", "--base-json", base, "--skip-local-write"],
    { GITHUB_TOKEN: "ghs_notarealtoken", GH_TOKEN: "" },
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /GITHUB_TOKEN cannot write to/);
  rmSync(dir, { recursive: true, force: true });
});

test("the publish reads the live remote and refuses an empty apps map", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /fetch_remote_json/);
  assert.match(src, /refusing to seed from the local snapshot/);
  assert.match(src, /--skip-push/);
  assert.doesNotMatch(src, /data = \{"schemaVersion": 1, "apps": \{\}\}/);
});

test("the published document keeps exactly one trailing newline", () => {
  const { dir, base, out } = fixture("afc-ios-versions-newline-", FLEET);
  const res = run([
    "--bundle-id",
    "com.socratictrade.ios",
    "--version",
    "1.0.69",
    "--build",
    "202608250045",
    "--base-json",
    base,
    "--out-json",
    out,
    "--skip-push",
    "--skip-local-write",
  ]);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  // The merge runs inside a command substitution, and a command substitution
  // strips trailing newlines.  The write has to put one back, or the file
  // lands in the repository without its final newline and every later commit
  // shows a spurious "no newline at end of file" line.
  const raw = readFileSync(out, "utf8");
  assert.ok(raw.endsWith("\n"), "the manifest must end with a newline");
  assert.ok(!raw.endsWith("\n\n"), "the manifest must end with exactly one newline");
  rmSync(dir, { recursive: true, force: true });
});

test("the manifest target is the org repository the apps read", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /Simple-With-Us\/AI-Fleet-Coordinator/);
  assert.match(src, /site\/ios-versions\.json/);
});

// ---- stubbed gh: a small fake GitHub, so the publish path runs without a network ----

const FAKE_GH = `#!/usr/bin/env python3
import base64, hashlib, json, os, sys
D = os.environ["FAKE_GH_DIR"]
S = json.load(open(D + "/state.json"))
args = sys.argv[1:]
line = " ".join(args)
open(D + "/calls.log", "a").write("gh " + line + "\\n")
def save():
    json.dump(S, open(D + "/state.json", "w"))
def blob(doc):
    return hashlib.md5(json.dumps(doc, sort_keys=True).encode()).hexdigest()
def tsv(doc):
    print(blob(doc) + "\\t" + base64.b64encode((json.dumps(doc, indent=2) + "\\n").encode()).decode())
def opt(name):
    return args[args.index(name) + 1] if name in args else None
def flag(name):
    return opt(name)
if args[0] == "pr":
    sys.exit(1 if S.get("mergeFail") else 0)
path = next((a for a in args if a.startswith("repos/")), "")
method = opt("--method") or "GET"
br = S["branch"]
if "/contents/" in path:
    ref = path.split("ref=")[-1] if "ref=" in path else None
    if method == "PUT":
        if S.get("race") and not S.get("raced"):
            S["raced"] = True
            br["doc"]["apps"]["raced.app"] = {"marketingVersion": "9.9.9"}
            br["ahead"] += 1
            save(); sys.exit(1)
        if opt("-f") is None: sys.exit(1)
        fields = {}
        i = 0
        while i < len(args):
            if args[i] == "-f":
                k, v = args[i + 1].split("=", 1); fields[k] = v; i += 2
            else: i += 1
        if fields.get("sha") != blob(br["doc"]): save(); sys.exit(1)
        br["doc"] = json.loads(base64.b64decode(fields["content"]))
        br["ahead"] += 1
        save(); sys.exit(0)
    if ref == "main": tsv(S["main"]["doc"])
    elif ref == "mbsha": tsv(br["mbDoc"])
    elif br and ref == S["branchName"]: tsv(br["doc"])
    else: sys.exit(1)
elif "/git/ref/heads/" in path:
    name = path.split("/git/ref/heads/")[-1]
    if name == "main": print("m1")
    elif br and name == S["branchName"]: print("b1")
    else: sys.exit(1)
elif "/compare/" in path:
    if "merge_base_commit" in line: print("mbsha")
    else: print(str(br["ahead"]) + "\\t" + str(br["behind"]))
elif "/git/refs/heads/" in path and method == "PATCH":
    force = "force=true" in line
    if force:
        br["doc"] = S["main"]["doc"]; br["ahead"] = 0; br["behind"] = 0
    else:
        if S.get("refRace"): sys.exit(1)
        br["doc"] = S["treeDoc"]; br["behind"] = 0
        S["merged"] = True
    save()
elif "/git/refs" in path and method == "POST":
    S["branch"] = {"doc": S["main"]["doc"], "ahead": 0, "behind": 0, "mbDoc": S["main"]["doc"]}; save()
elif "/git/commits/" in path: print("tree1")
elif path.endswith("/git/trees"):
    body = json.loads(sys.stdin.read()); S["treeDoc"] = json.loads(body["tree"][0]["content"]); save(); print("tree2")
elif path.endswith("/git/commits"):
    sys.stdin.read(); print("commit2")
elif "/pulls?head=" in path:
    if S.get("prOpen"): print(1)
elif path.endswith("/pulls") and method == "POST":
    S["prOpen"] = True; save(); print("https://github.com/Simple-With-Us/AI-Fleet-Coordinator/pull/1")
sys.exit(0)
`;

function stubDir(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "afc-ios-stub-"));
  const main = opts.live || FLEET;
  const state = {
    main: { doc: main },
    branchName: "ios-versions-publish/fleet",
    branch: opts.branch
      ? { ahead: 1, behind: 0, mbDoc: main, ...opts.branch }
      : null,
    prOpen: Boolean(opts.branch),
    mergeFail: Boolean(opts.mergeFail),
    race: Boolean(opts.race),
    refRace: Boolean(opts.refRace),
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

const stateOf = (stub) => JSON.parse(readFileSync(join(stub, "state.json"), "utf8"));
const callsOf = (stub) => readFileSync(join(stub, "calls.log"), "utf8");

function publish(stub, extra = [], env = {}) {
  return run(
    ["--bundle-id", "com.socratictrade.ios", "--version", "1.0.69", "--skip-local-write", ...extra],
    { PATH: `${stub}:${process.env.PATH}`, FAKE_GH_DIR: stub, GH_TOKEN: "ghp_notarealtoken", GITHUB_TOKEN: "", ...env },
  );
}

test("a failed auto-merge arm exits nonzero after the pull request exists", () => {
  const stub = stubDir({ mergeFail: true });
  const res = publish(stub);
  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /version-manifest-pr https:\/\/github.com/);
  assert.match(res.stderr, /auto-merge could not be armed/);
  rmSync(stub, { recursive: true, force: true });
});

test("a first publish creates the shared branch and lands the bump on it", () => {
  const stub = stubDir();
  const res = publish(stub);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /auto-merge armed/);
  const st = stateOf(stub);
  assert.equal(st.branch.doc.apps["com.socratictrade.ios"].marketingVersion, "1.0.69");
  assert.deepEqual(Object.keys(st.branch.doc.apps).sort(), Object.keys(FLEET.apps).sort());
  rmSync(stub, { recursive: true, force: true });
});

test("a second publish lands on the open shared branch and keeps the pending bump", () => {
  const pending = JSON.parse(JSON.stringify(FLEET));
  pending.apps["net.dealdex"].marketingVersion = "1.0.3";
  const stub = stubDir({ branch: { doc: pending } });
  const res = publish(stub);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const st = stateOf(stub);
  assert.equal(st.branch.doc.apps["net.dealdex"].marketingVersion, "1.0.3", "pending bump kept");
  assert.equal(st.branch.doc.apps["com.socratictrade.ios"].marketingVersion, "1.0.69", "new bump added");
  assert.doesNotMatch(callsOf(stub), /force=true/, "an ahead branch is never force-moved");
  assert.doesNotMatch(callsOf(stub), /method POST .*\/pulls /, "the open pull request is reused");
  rmSync(stub, { recursive: true, force: true });
});

test("a writer that loses the compare-and-swap re-reads and keeps the other writer's app", () => {
  const stub = stubDir({ branch: { doc: FLEET }, race: true });
  const res = publish(stub);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stderr, /moved under this publish/);
  const st = stateOf(stub);
  assert.equal(st.branch.doc.apps["raced.app"].marketingVersion, "9.9.9", "the raced bump survives");
  assert.equal(st.branch.doc.apps["com.socratictrade.ios"].marketingVersion, "1.0.69");
  rmSync(stub, { recursive: true, force: true });
});

test("when the default branch moved, the branch is merged up without a force and keeps both sides", () => {
  const base = FLEET;
  const live = JSON.parse(JSON.stringify(FLEET));
  live.apps["trade.congress.ios"].marketingVersion = "1.0.81";
  live.updatedAt = "2026-08-25T00:00:00Z";
  const pending = JSON.parse(JSON.stringify(FLEET));
  pending.apps["net.dealdex"].marketingVersion = "1.0.3";
  pending.updatedAt = "2026-08-24T09:00:00Z";
  const stub = stubDir({ live, branch: { doc: pending, mbDoc: base, behind: 2 } });
  const res = publish(stub);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const st = stateOf(stub);
  assert.equal(st.merged, true);
  assert.equal(st.branch.doc.apps["trade.congress.ios"].marketingVersion, "1.0.81", "default branch change kept");
  assert.equal(st.branch.doc.apps["net.dealdex"].marketingVersion, "1.0.3", "pending bump kept");
  assert.equal(st.branch.doc.apps["com.socratictrade.ios"].marketingVersion, "1.0.69");
  assert.doesNotMatch(callsOf(stub), /force=true/);
  rmSync(stub, { recursive: true, force: true });
});

test("an app both the branch and the default branch changed differently is refused, nothing written", () => {
  const live = JSON.parse(JSON.stringify(FLEET));
  live.apps["net.dealdex"].marketingVersion = "1.0.9";
  const pending = JSON.parse(JSON.stringify(FLEET));
  pending.apps["net.dealdex"].marketingVersion = "1.0.3";
  const stub = stubDir({ live, branch: { doc: pending, mbDoc: FLEET, behind: 1 } });
  const res = publish(stub);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /both the branch and the default branch changed net.dealdex/);
  assert.doesNotMatch(callsOf(stub), /--method PUT/);
  assert.doesNotMatch(callsOf(stub), /force=true/);
  rmSync(stub, { recursive: true, force: true });
});

test("a document that drops an app the default branch has is refused before any write", () => {
  const thin = { schemaVersion: 1, apps: { "com.socratictrade.ios": { marketingVersion: "1.0.68" } } };
  const stub = stubDir({ branch: { doc: thin } });
  const res = publish(stub);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /drop apps the live remote has/);
  assert.doesNotMatch(callsOf(stub), /--method PUT/);
  rmSync(stub, { recursive: true, force: true });
});

test("there is no local-snapshot fallback when the live manifest cannot be read", () => {
  const stub = mkdtempSync(join(tmpdir(), "afc-ios-stub-"));
  writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(join(stub, "gh"), 0o755);
  const res = publish(stub);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /could not read the live manifest/);
  rmSync(stub, { recursive: true, force: true });
});

test("a change to the Apple ID or display name is not a no-op", () => {
  const { dir, base } = fixture("afc-ios-versions-meta-", FLEET);
  const res = run(
    ["--bundle-id", "com.socratictrade.ios", "--version", "1.0.68", "--apple-id", "1111111199", "--base-json", base, "--skip-local-write"],
    { GH_TOKEN: "", GITHUB_TOKEN: "ghs_notarealtoken" },
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /GITHUB_TOKEN cannot write to/);
  rmSync(dir, { recursive: true, force: true });
});

test("the no-op check compares the base as read, even when --out-json is the same file", () => {
  const { dir, base } = fixture("afc-ios-versions-same-", FLEET);
  const res = run(
    ["--bundle-id", "com.socratictrade.ios", "--version", "1.0.69", "--base-json", base, "--out-json", base, "--skip-local-write"],
    { GH_TOKEN: "", GITHUB_TOKEN: "ghs_notarealtoken" },
  );
  assert.notEqual(res.status, 0);
  assert.doesNotMatch(res.stdout, /already recorded/);
  rmSync(dir, { recursive: true, force: true });
});

test("a bare gh login is not a credential; fleet-secrets GH_PAT is, or the run fails", () => {
  const { dir, base } = fixture("afc-ios-versions-pat-", FLEET);
  const stub = mkdtempSync(join(tmpdir(), "afc-ios-stub-"));
  writeFileSync(join(stub, "fleet-secrets"), "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(join(stub, "fleet-secrets"), 0o755);
  writeFileSync(join(stub, "gh"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(stub, "gh"), 0o755);
  const res = run(
    ["--bundle-id", "com.socratictrade.ios", "--version", "1.0.69", "--base-json", base, "--skip-local-write"],
    { PATH: `${stub}:${process.env.PATH}`, GH_TOKEN: "", GITHUB_TOKEN: "" },
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /fleet-secrets could not return GH_PAT/);
  rmSync(dir, { recursive: true, force: true });
  rmSync(stub, { recursive: true, force: true });
});

test("an option with no value is a usage error, not an unbound variable", () => {
  const res = run(["--bundle-id", "com.socratictrade.ios", "--version"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--version needs a value/);
});

// ---- release gates: icon audit and sheet sync -----------------------------

function auditStub(code) {
  const dir = mkdtempSync(join(tmpdir(), "afc-ios-audit-"));
  const file = join(dir, "audit.mjs");
  writeFileSync(file, `process.exit(${code});\n`);
  return { dir, file };
}

test("the icon audit blocks the publish by default and on an audit error", () => {
  const stub = stubDir();
  const audit = auditStub(1);
  for (const env of [{ FLEET_ICON_AUDIT: "" }, { FLEET_ICON_AUDIT: "block" }]) {
    const res = publish(stub, [], { ...env, FLEET_ICON_AUDIT_SCRIPT: audit.file });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /icon audit failed or could not run/);
  }
  rmSync(stub, { recursive: true, force: true });
  rmSync(audit.dir, { recursive: true, force: true });
});

test("a missing audit script blocks too, warn continues, off skips", () => {
  const stub = stubDir();
  const missing = join(tmpdir(), "afc-no-such-audit.mjs");
  const blocked = publish(stub, [], { FLEET_ICON_AUDIT: "block", FLEET_ICON_AUDIT_SCRIPT: missing });
  assert.notEqual(blocked.status, 0);
  const audit = auditStub(1);
  const warned = publish(stub, [], { FLEET_ICON_AUDIT: "warn", FLEET_ICON_AUDIT_SCRIPT: audit.file });
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /publishing anyway/);
  const off = publish(stub, [], { FLEET_ICON_AUDIT: "off", FLEET_ICON_AUDIT_SCRIPT: missing });
  assert.equal(off.status, 0, off.stderr);
  const bad = publish(stub, [], { FLEET_ICON_AUDIT: "maybe" });
  assert.equal(bad.status, 2);
  rmSync(stub, { recursive: true, force: true });
  rmSync(audit.dir, { recursive: true, force: true });
});

test("the sheet sync runs after the publish, a failure fails the run, a missing shim is skipped", () => {
  const stub = stubDir();
  const ok = auditStub(0);
  const bad = auditStub(1);
  const done = publish(stub, [], { FLEET_SHEET_SYNC: ok.file });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /sheet-sync: done/);
  const failed = publish(stub, [], { FLEET_SHEET_SYNC: bad.file });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /sheet sync failed/);
  const skipped = publish(stub, [], { FLEET_SHEET_SYNC: join(tmpdir(), "afc-no-shim.mjs") });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.match(skipped.stdout, /not present, skipped/);
  rmSync(stub, { recursive: true, force: true });
  rmSync(ok.dir, { recursive: true, force: true });
  rmSync(bad.dir, { recursive: true, force: true });
});

test("the local cache is written only after the publish, never before a failed one", () => {
  const copy = mkdtempSync(join(tmpdir(), "afc-ios-copy-"));
  const script = join(copy, "publish-ios-versions.sh");
  writeFileSync(script, readFileSync(SCRIPT));
  const cache = join(copy, "ios-app-versions.json");
  const args = ["--bundle-id", "com.socratictrade.ios", "--version", "1.0.69"];
  const thin = { schemaVersion: 1, apps: { "com.socratictrade.ios": { marketingVersion: "1.0.68" } } };
  const bad = stubDir({ branch: { doc: thin } });
  const failed = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, FLEET_ICON_AUDIT: "off", PATH: `${bad}:${process.env.PATH}`, FAKE_GH_DIR: bad, GH_TOKEN: "ghp_notarealtoken", GITHUB_TOKEN: "" },
  });
  assert.notEqual(failed.status, 0);
  assert.ok(!existsSync(cache), "a failed publish must not write the local cache");
  const good = stubDir();
  const done = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, FLEET_ICON_AUDIT: "off", PATH: `${good}:${process.env.PATH}`, FAKE_GH_DIR: good, GH_TOKEN: "ghp_notarealtoken", GITHUB_TOKEN: "" },
  });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(readFileSync(cache, "utf8")).apps["com.socratictrade.ios"].marketingVersion, "1.0.69");
  for (const d of [copy, bad, good]) rmSync(d, { recursive: true, force: true });
});

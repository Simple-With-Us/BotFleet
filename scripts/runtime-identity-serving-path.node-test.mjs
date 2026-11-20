// BF-2649 (audit S23):  pin the runtime-identity fingerprint walk off the
// serving path.
//
// The server's runtime identity carries two computed fingerprints:  the
// source build identity (git HEAD plus dirty flag) and the static-UI hash,
// which `hashStaticUi` computes by walking every file of the static UI
// directory and reading each file's bytes.  Both run exactly once, at module
// load, inside `server/runtime-identity.ts`;  the exported
// `runtimeBuildIdentity` object is the only thing the serving code ever
// reads.  A performance finding on PR #1539 made the risk concrete:  if a
// request-serving route ever re-ran the walk, every status read would crawl
// the static tree again.
//
// This file pins that wiring in the source, so the walk cannot drift back
// onto the serving path unnoticed:
//   1. `server/runtime-identity.ts` is the only server module that calls the
//      two walking readers, and each call site is exactly the load-time one.
//   2. No other module under `server/` imports the walk modules
//      (`../scripts/source-build-identity.mjs` or
//      `../scripts/release-provenance.mjs`, whose dependency-tree walk is the
//      heavier sibling of the UI walk).
//   3. `server/index.ts` reads the precomputed `runtimeBuildIdentity` object
//      and never re-derives identity inside a route.
//
// Recipe note:  `docs/verification/mac-updater.md` records where this test
// sits in the updater qualification chain.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Every TypeScript module under server/, tests excluded. */
function serverModules() {
  return readdirSync(join(ROOT, "server"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => `server/${name}`);
}

test("the runtime identity module computes both fingerprints exactly once, at module load", () => {
  const source = read("server/runtime-identity.ts");
  // The identity object is a top-level const, not a function a route could
  // call again:  the load-time evaluation is what keeps the walk off every
  // request.
  assert.match(source, /const sourceIdentity: BuildIdentity = import\.meta\.url\.endsWith\("\.ts"\)/);
  assert.match(source, /const runtimeBuildIdentity = \{ \.\.\.sourceIdentity, uiHash: hashStaticUi\(process\.env\.OMB_STATIC_DIR\) \};/);
  // Each walking reader is called exactly once — the load-time line above is
  // the only call site in the module.
  assert.equal(source.match(/hashStaticUi\(/g)?.length, 1, "hashStaticUi must be called exactly once, at module load");
  assert.equal(source.match(/readSourceBuildIdentity\(/g)?.length, 1, "readSourceBuildIdentity must be called exactly once, at module load");
  // The module exports the precomputed object and two pure helpers — no
  // function that re-runs a walk is exported to callers.
  assert.match(source, /export const runtimeBuildIdentity/);
  assert.doesNotMatch(source, /export (async )?function (hashStaticUi|readSourceBuildIdentity|recompute|refresh)/);
});

test("no other server module reaches the fingerprint walk or its modules", () => {
  const offenders = [];
  for (const module of serverModules()) {
    if (module === "server/runtime-identity.ts") continue;
    const source = read(module);
    if (/hashStaticUi|readSourceBuildIdentity/.test(source)) offenders.push(`${module} calls a walking reader`);
    if (/\.\.\/scripts\/source-build-identity\.mjs/.test(source)) offenders.push(`${module} imports source-build-identity.mjs`);
    if (/\.\.\/scripts\/release-provenance\.mjs/.test(source)) offenders.push(`${module} imports release-provenance.mjs (the dependency-tree walk)`);
    if (/\.\.\/electron\/runtime-identity\.mjs/.test(source) && !/authorizedRuntime|validBuildIdentity|buildCompatibility/.test(source)) {
      offenders.push(`${module} imports electron/runtime-identity.mjs without naming a non-walking export`);
    }
  }
  assert.deepEqual(offenders, [], "the fingerprint walk must be reachable only through server/runtime-identity.ts at module load");
});

test("the serving entry reads the precomputed identity object and never re-derives it", () => {
  const index = read("server/index.ts");
  assert.match(index, /import \{ runtimeBuildIdentity, runtimeReadiness, sweepMapIfPresent \} from "\.\/runtime-identity\.ts";/);
  // Every reference is a property read of the precomputed object.  A call
  // would mean the route recomputes identity per request.
  assert.doesNotMatch(index, /runtimeBuildIdentity\(/);
});

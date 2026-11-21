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

/** Source with comments removed, so a comment that mentions a walking reader
 *  is not miscounted as a call site.  This is a small string-aware scanner,
 *  not a regex:  quoted contents (single, double and template) are copied
 *  verbatim — a `//` or `/*` inside a string or a URL never starts a
 *  comment — while line and block comments outside strings are dropped.
 *  Line comments keep their trailing newline so line structure survives. */
function withoutLineComments(source) {
  let out = "";
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Every TypeScript module under server/ at any depth, tests excluded. */
function serverModules() {
  return readdirSync(join(ROOT, "server"), { recursive: true })
    .map((name) => String(name).replaceAll("\\", "/"))
    .filter((name) => /\.(?:ts|mts|mjs)$/.test(name) && !/\.test\.(?:ts|mts|mjs)$/.test(name))
    .map((name) => `server/${name}`);
}

test("the runtime identity module computes both fingerprints exactly once, at module load", () => {
  const source = withoutLineComments(read("server/runtime-identity.ts"));
  // The identity object is a top-level const, not a function a route could
  // call again:  the load-time evaluation is what keeps the walk off every
  // request.  The pins are tolerant of reformatting — they hold the shape
  // (a top-level const initialized from the two walking readers), not the
  // exact bytes.
  assert.match(source, /const sourceIdentity: BuildIdentity = import\.meta\.url\.endsWith\("\.ts"\)/);
  assert.match(source, /const runtimeBuildIdentity = \{[^}]*hashStaticUi\(process\.env\.OMB_STATIC_DIR\)[^}]*\};/s);
  // Each walking reader is called exactly once — the load-time line above is
  // the only call site in the module, counted with comments stripped.
  assert.equal(source.match(/hashStaticUi\(/g)?.length, 1, "hashStaticUi must be called exactly once, at module load");
  assert.equal(source.match(/readSourceBuildIdentity\(/g)?.length, 1, "readSourceBuildIdentity must be called exactly once, at module load");
  // The module exports the precomputed object and two pure helpers — no
  // function that re-runs a walk is exported to callers.
  assert.match(source, /export const runtimeBuildIdentity/);
  assert.doesNotMatch(source, /export (?:async )?function (?:hashStaticUi|readSourceBuildIdentity|recompute|refresh)/);
});

test("no other server module reaches the fingerprint walk or its modules", () => {
  const offenders = [];
  for (const module of serverModules()) {
    if (module === "server/runtime-identity.ts") continue;
    const source = withoutLineComments(read(module));
    if (/hashStaticUi|readSourceBuildIdentity/.test(source)) offenders.push(`${module} calls a walking reader`);
    if (/scripts\/source-build-identity\.mjs/.test(source)) offenders.push(`${module} imports source-build-identity.mjs`);
    if (/scripts\/release-provenance\.mjs/.test(source)) offenders.push(`${module} imports release-provenance.mjs (the dependency-tree walk)`);
    if (/electron\/runtime-identity\.mjs/.test(source) && !/authorizedRuntime|validBuildIdentity|buildCompatibility/.test(source)) {
      offenders.push(`${module} imports electron/runtime-identity.mjs without naming a non-walking export`);
    }
  }
  assert.deepEqual(offenders, [], "the fingerprint walk must be reachable only through server/runtime-identity.ts at module load");
});

test("the serving entry reads the precomputed identity object and never re-derives it", () => {
  const index = withoutLineComments(read("server/index.ts"));
  // The import relationship is pinned by name, not by exact line formatting.
  assert.match(index, /import \{[^}]*runtimeBuildIdentity[^}]*\} from "\.\/runtime-identity\.ts";/);
  // Every reference is a property read of the precomputed object.  A call
  // would mean the route recomputes identity per request.
  assert.doesNotMatch(index, /runtimeBuildIdentity\(/);
});

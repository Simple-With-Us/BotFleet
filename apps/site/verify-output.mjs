#!/usr/bin/env node
/**
 * Fails if the directory Vercel deploys contains anything it should not.
 *
 * `outputDirectory` is `dist/`, and this is the check that keeps it that
 * way.  The site source folder also holds README.md, docs/EFFORT-LOG.md,
 * vercel-ignore-hourly.sh, sync-status.mjs, build.mjs, template.html,
 * features.json, and package.json — every one of which was readable at
 * https://botfleet.app/<name> while `outputDirectory` was `.`.  A future
 * "just copy the whole folder" change, or an asset added straight into
 * dist/, has to fail here rather than ship.
 *
 * Run:  node apps/site/verify-output.mjs
 * Exit: 0 clean, 1 on any finding.  No network, no Vercel account.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_ASSETS } from "./public-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "dist");

/** Basenames that must never appear anywhere in the deployed tree, at any
 * depth.  Matched case-insensitively and by suffix for the extension ones,
 * so `Docs/`, `readme.MD`, and `deploy.sh` are all caught. */
const BANNED_BASENAMES = new Set(["readme.md", "package.json", "package-lock.json", "effort-log.md"]);
const BANNED_SUFFIXES = [".sh", ".mjs", ".cjs", ".js", ".map", ".ts", ".md", ".env"];
// A whole internal directory — `docs/`, `node_modules/`, `.github/` — needs no
// rule of its own: every file inside one trips a basename or a suffix below,
// and a stray dot-directory is caught by the segment walk.  A `docs/` entry
// here would be the one check in this file that cannot fail.

/** The one directory that is legitimately dotted. */
const ALLOWED_DOTTED = new Set([".well-known"]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const findings = [];

if (!existsSync(OUT_DIR)) {
  findings.push("dist/ does not exist — run `node apps/site/build.mjs` before verifying.");
} else {
  const files = walk(OUT_DIR);
  const relPaths = files.map((file) => relative(OUT_DIR, file).split(sep).join("/"));
  const expected = new Set(["index.html", ...PUBLIC_ASSETS]);

  for (const rel of relPaths) {
    const segments = rel.split("/");
    const base = segments[segments.length - 1].toLowerCase();

    if (BANNED_BASENAMES.has(base)) findings.push(`${rel}: an internal metadata file is inside the deployed input`);
    if (BANNED_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
      findings.push(`${rel}: source or documentation file extension is inside the deployed input`);
    }
    for (const segment of segments.slice(0, -1)) {
      if (segment.startsWith(".") && !ALLOWED_DOTTED.has(segment)) {
        findings.push(`${rel}: unexpected dot-directory "${segment}" in the deployed input`);
      }
    }
    if (!expected.has(rel)) findings.push(`${rel}: not in build.mjs's PUBLIC_ASSETS allowlist — add it there or remove it`);
  }

  for (const rel of expected) {
    if (!relPaths.includes(rel)) findings.push(`${rel}: expected in the deployed input but missing`);
  }

  // The iOS app fetches this path for Universal Links and web credentials,
  // and vercel.json gives it a JSON content type.  Losing it breaks pairing
  // silently, so it is asserted rather than assumed.
  const aasa = join(OUT_DIR, ".well-known", "apple-app-site-association");
  if (existsSync(aasa)) {
    try {
      JSON.parse(readFileSync(aasa, "utf8"));
    } catch (cause) {
      findings.push(`.well-known/apple-app-site-association is not valid JSON: ${cause.message}`);
    }
  }

  const vercel = JSON.parse(readFileSync(join(here, "vercel.json"), "utf8"));
  if (vercel.outputDirectory !== "dist") {
    findings.push(`vercel.json outputDirectory is "${vercel.outputDirectory}", expected "dist"`);
  }

  console.log(`deployed input: ${relPaths.length} files`);
  for (const rel of relPaths.sort()) console.log(`  ${rel}`);
}

if (findings.length > 0) {
  console.error(`\n${findings.length} finding(s):`);
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log("clean: no internal files in the deployed input");

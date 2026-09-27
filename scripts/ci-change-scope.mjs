import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT_DOCUMENTS = new Set([
  "AGENTS.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "README.md",
  "SECURITY.md",
]);

const FULL_CI_DOCUMENTS = new Set(["docs/secrets.md"]);

export function isDocumentationPath(path) {
  return !FULL_CI_DOCUMENTS.has(path) && (ROOT_DOCUMENTS.has(path) || path.startsWith("docs/"));
}

// Per-area path filters feeding the expensive jobs' own `if` gates (mirrors
// the docs_only fast path already honoured inside those jobs).  Each area
// also mixes in .github/workflows/ci.yml where a workflow edit could change
// that job's own definition -- see the `ios` note below for why the others
// don't need it too: their steps live in dedicated scripts this classifier
// already tracks (scripts/prepare-*.mjs, scripts/package-*), so a change to
// just the job's YAML wiring with no script change is rare and low-cost.
export function isIosPath(path) {
  // ci.yml is the only place the `ios` job is defined -- there is no
  // separate ios-ci.yml the way packaging has package-linux.yml -- so a
  // workflow edit here can change the job itself, not just build scripts.
  return path === ".github/workflows/ci.yml" || path.startsWith("ios/") || path.startsWith("scripts/ios-");
}

export function isPackagingPath(path) {
  return (
    path === "electron-builder.yml" ||
    path === "package.json" ||
    path === "pnpm-lock.yaml" ||
    path.startsWith("electron/") ||
    path.startsWith("third_party/") ||
    path.startsWith("scripts/prepare-") ||
    path.startsWith("scripts/package-")
  );
}

export function isControlPlanePath(path) {
  return path.startsWith("cloudflare/");
}

export function classifyCIPaths(paths) {
  const changedPaths = paths.filter(Boolean);
  const hasChanges = changedPaths.length > 0;
  // Fail-closed the same way docsOnly already does: with no changed-path
  // information (an empty list, exactly the fallback the workflow's own
  // schedule/dispatch and missing-base-SHA branches also use) every area is
  // "changed" and the full job runs, rather than every area silently
  // skipping its expensive steps.
  return {
    changedCount: changedPaths.length,
    docsOnly: hasChanges && changedPaths.every(isDocumentationPath),
    iosChanged: !hasChanges || changedPaths.some(isIosPath),
    packagingChanged: !hasChanges || changedPaths.some(isPackagingPath),
    controlPlaneChanged: !hasChanges || changedPaths.some(isControlPlanePath),
  };
}

function main() {
  const paths = readFileSync(0)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const result = classifyCIPaths(paths);

  // This output is appended directly to GITHUB_OUTPUT.  Never echo a changed
  // filename here because pull requests control those bytes.
  process.stdout.write(
    `docs_only=${result.docsOnly}\n` +
      `changed_count=${result.changedCount}\n` +
      `ios_changed=${result.iosChanged}\n` +
      `packaging_changed=${result.packagingChanged}\n` +
      `control_plane_changed=${result.controlPlaneChanged}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

// Name the CI jobs that still build or test the Node desktop (BF-2515).
//
// The decommission's second Done condition is "CI is green with no Node
// desktop job", and until now nothing read the workflow job set: the gate
// asked a person to confirm it.  A job that still runs `pnpm test` or
// `electron-builder` is the desktop being kept alive by CI, so the gate has
// to name it — file, job id, job name and the pattern that matched — or a
// removal cannot be audited afterwards.
//
// The scan is fail closed.  A workflow file that cannot be read or parsed is
// an error, never a silently skipped file: a gate that quietly ignores the
// one file it could not understand is a gate that passes on an unreadable
// input.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * The Node desktop work a surviving CI job would perform.  The first five
 * are commands; the last is the display name the Node test job carries, so
 * a job renamed to something harmless still gets caught by what it runs.
 *
 * `pnpm typecheck` is in the list on its own: a job that only typechecks
 * still needs the Node toolchain and the desktop's tsconfig, so it is a Node
 * desktop job even though it runs no test.
 */
export const NODE_DESKTOP_PATTERNS = [
  "pnpm test",
  "pnpm typecheck",
  "pnpm package:",
  "vite build",
  "electron-builder",
  "typecheck + test",
];

/**
 * Does this text mention the pattern?  Case-insensitive on purpose: a
 * workflow may write `PNPM TEST` in a matrix or an echoed command, and the
 * job is the same job either way.
 */
function mentions(text, pattern) {
  return String(text).toLowerCase().includes(pattern.toLowerCase());
}

/**
 * The offending jobs in one parsed workflow.  Pure over the parsed object
 * so the test suite can hand it a small fixture, while the CLI hands it the
 * real files.  A job is reported once per pattern it trips, and the job's
 * display name is carried along because the id alone rarely says what the
 * job is for.
 */
export function findNodeDesktopJobs(workflow, fileName) {
  const offenders = [];
  const jobs = workflow?.jobs ?? {};
  for (const [jobId, job] of Object.entries(jobs)) {
    const displayName = String(job?.name ?? jobId);
    const seen = new Set();
    const record = (pattern) => {
      if (seen.has(pattern)) return;
      seen.add(pattern);
      offenders.push({ file: fileName, job: jobId, name: displayName, pattern });
    };
    for (const pattern of NODE_DESKTOP_PATTERNS) {
      if (mentions(displayName, pattern)) record(pattern);
    }
    for (const step of job?.steps ?? []) {
      const text = `${step?.name ?? ""}\n${step?.run ?? ""}`;
      for (const pattern of NODE_DESKTOP_PATTERNS) {
        if (mentions(text, pattern)) record(pattern);
      }
    }
  }
  return offenders;
}

/**
 * Read and parse one workflow file.  Throws with the file name attached so
 * the CLI can report exactly which file it could not read.
 */
export function readWorkflow(filePath) {
  const text = readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${filePath} is not valid YAML: ${message}`);
  }
  if (parsed === null || parsed === undefined) {
    throw new Error(`${filePath} parsed as an empty document`);
  }
  if (parsed.jobs === null || parsed.jobs === undefined) {
    throw new Error(`${filePath} has no jobs: a workflow with no job set cannot be judged clean`);
  }
  return parsed;
}

// Compare physical paths.  Node's ESM loader realpaths the entry module, so an
// invocation through a symlinked directory (macOS /var -> /private/var) never
// matches process.argv[1] when compared as text.
function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  const args = process.argv.slice(2);
  const flagIndex = args.indexOf("--repo-root");
  let repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (flagIndex !== -1) {
    const value = args[flagIndex + 1];
    if (!value || value.startsWith("--")) {
      console.error("usage: node scripts/check-node-ci-jobs.mjs [--repo-root <path>]");
      process.exit(2);
    }
    repoRoot = value;
  }

  const workflowsDir = join(repoRoot, ".github", "workflows");
  let entries;
  try {
    entries = readdirSync(workflowsDir, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: could not read the workflow directory ${workflowsDir}: ${message}`);
    process.exit(2);
  }

  // Both extensions are read: a workflow parked in .yaml would otherwise be
  // invisible, and an invisible workflow is a gate that passes on an
  // unreadable input.
  const files = entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")))
    .map((entry) => entry.name)
    .sort();

  const offenders = [];
  for (const name of files) {
    const filePath = join(workflowsDir, name);
    let workflow;
    try {
      workflow = readWorkflow(filePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`error: ${message}`);
      console.error("refusing to skip a workflow this gate could not read");
      process.exit(2);
    }
    const label = relative(repoRoot, filePath);
    offenders.push(...findNodeDesktopJobs(workflow, label));
  }

  if (offenders.length > 0) {
    console.error(`Node desktop CI gate: FAILED — ${offenders.length} job match(es) still build or test the Node desktop`);
    for (const offender of offenders) {
      console.error(
        `  - ${offender.file}: job "${offender.job}" ("${offender.name}") matches "${offender.pattern}"`,
      );
    }
    console.error("Remove the Node desktop job from the workflow, then re-run this gate.");
    process.exit(1);
  }

  console.log(
    `Node desktop CI gate: ${files.length} workflow file(s) read, no job runs the Node desktop.`,
  );
}

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
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

/**
 * The Node desktop work a surviving CI job would perform.  The last entry is
 * the display name the Node test job carries, so a job renamed to something
 * harmless still gets caught by what it runs.
 *
 * `pnpm typecheck` is in the list on its own: a job that only typechecks
 * still needs the Node toolchain and the desktop's tsconfig, so it is a Node
 * desktop job even though it runs no test.
 *
 * `pnpm install` is in the list one step earlier, for the same reason.  The
 * root manifest and lockfile hold the whole desktop dependency closure, so a
 * job that installs it is a job that cannot outlive the desktop.  No workflow
 * installs a package of its own — `cloudflare/` carries no manifest of its
 * own, and the two autofix workflows install a pinned CLI instead — so a root
 * install is a desktop install.  `pnpm lint` is in the list because it runs
 * the desktop lint toolchain over the tree.
 */
export const NODE_DESKTOP_PATTERNS = [
  "pnpm test",
  "pnpm typecheck",
  "pnpm lint",
  "pnpm install",
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
    // A job can reach the Node desktop without naming a command in a step:
    // through a reusable workflow, or through a matrix value.  Those are read
    // too, or a job that delegates the desktop build would slip past a gate
    // that only reads steps.
    //
    // A `with:` value is deliberately NOT read.  It is opaque data handed to
    // another workflow, and a workflow that merely mentions the command in a
    // prompt is not a Node desktop job;  naming it as one would make this
    // gate report offenders that do not exist, and an audit that cries wolf
    // is not an audit.
    const indirect = [job?.uses ?? "", JSON.stringify(job?.strategy ?? {})].join("\n");
    for (const pattern of NODE_DESKTOP_PATTERNS) {
      if (mentions(indirect, pattern)) record(pattern);
    }
  }
  return offenders;
}

/**
 * The Node desktop work inside one composite action.  A job that calls a
 * local composite action delegates its steps to that action, so the action's
 * own steps are read for the same reason reusable workflows and matrix
 * values are read: a step that lives in the action still runs the desktop.
 *
 * Pure over the parsed object, like the workflow scan above.
 */
export function findNodeDesktopActionSteps(action, fileName, actionId) {
  const offenders = [];
  const steps = action?.runs?.steps ?? [];
  const displayName = String(action?.name ?? actionId);
  const seen = new Set();
  for (const step of steps) {
    const text = `${step?.name ?? ""}\n${step?.run ?? ""}`;
    for (const pattern of NODE_DESKTOP_PATTERNS) {
      if (!mentions(text, pattern)) continue;
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      offenders.push({ file: fileName, job: actionId, name: displayName, pattern });
    }
  }
  return offenders;
}

/**
 * The composite actions a checkout carries, as absolute paths.  GitHub reads
 * an action from `.github/actions/<name>/action.yml` or `action.yaml`, one
 * directory deep, so that is what is collected here.
 *
 * A checkout with no `.github/actions` directory carries no composite action
 * and is not an error;  a directory that exists but cannot be read is one,
 * because a gate that quietly ignores the one place it could not look is a
 * gate that passes on an unreadable input.
 */
export function compositeActionFiles(repoRoot) {
  const actionsDir = join(repoRoot, ".github", "actions");
  let entries;
  try {
    entries = readdirSync(actionsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const name of ["action.yml", "action.yaml"]) {
      const candidate = join(actionsDir, entry.name, name);
      if (existsSync(candidate)) files.push({ path: candidate, id: entry.name });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The shapes this gate reads, validated at the trust boundary.
 *
 * A workflow file is untrusted input:  it is YAML on disk that anybody with
 * write access can edit.  Reading it with optional chaining instead of a
 * schema means a malformed shape either crashes the gate or, worse, reads as
 * an empty job set and passes.  So the parsed document is validated, and a
 * shape that does not match is refused rather than judged.
 *
 * `.passthrough()` keeps every key this gate does not read, because a
 * workflow carries a great deal that is none of the gate's business.
 */
const StepSchema = z
  .object({
    name: z.string().optional(),
    run: z.string().optional(),
    uses: z.string().optional(),
  })
  .passthrough();

const JobSchema = z
  .object({
    name: z.string().optional(),
    uses: z.string().optional(),
    steps: z.array(StepSchema).optional(),
    strategy: z.unknown().optional(),
  })
  .passthrough();

export const WorkflowSchema = z
  .object({
    jobs: z.record(z.string(), JobSchema),
  })
  .passthrough();

export const CompositeActionSchema = z
  .object({
    name: z.string().optional(),
    runs: z
      .object({
        using: z.string().optional(),
        steps: z.array(StepSchema).optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * The short reason a document failed its schema.  The full issue list is long
 * and names paths the reader cannot act on;  the path and the message are
 * what says which shape is wrong.
 */
function schemaFailure(error) {
  const issue = error?.issues?.[0];
  if (!issue) return "the document does not match the expected shape";
  const path = issue.path?.length ? issue.path.join(".") : "(document)";
  return `${path}: ${issue.message}`;
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
  const result = WorkflowSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${filePath} is not a workflow shape this gate can judge: ${schemaFailure(result.error)}`);
  }
  return result.data;
}

/**
 * Read and parse one composite action file.  Throws with the file name
 * attached so the CLI can report exactly which file it could not read.
 *
 * An action is not a workflow and carries no `jobs:` key, so it is read on
 * its own terms: a composite action has `runs.steps`, and a docker or
 * JavaScript action has no steps to read at all.
 */
export function readCompositeAction(filePath) {
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
  const result = CompositeActionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${filePath} is not a composite action shape this gate can judge: ${schemaFailure(result.error)}`);
  }
  return result.data;
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

  // The composite actions the workflows call.  A job that delegates its steps
  // to a local action runs the desktop through the action, so the action's
  // own steps are read here for the same reason the reusable workflow and
  // matrix references are read above.
  let actionFiles = [];
  try {
    actionFiles = compositeActionFiles(repoRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: could not read the composite action directory: ${message}`);
    console.error("refusing to skip a composite action this gate could not read");
    process.exit(2);
  }
  for (const { path: actionPath, id } of actionFiles) {
    let action;
    try {
      action = readCompositeAction(actionPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`error: ${message}`);
      console.error("refusing to skip a composite action this gate could not read");
      process.exit(2);
    }
    const label = relative(repoRoot, actionPath);
    offenders.push(...findNodeDesktopActionSteps(action, label, id));
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
    `Node desktop CI gate: ${files.length} workflow file(s) and ${actionFiles.length} composite action(s) read, no job runs the Node desktop.`,
  );
}

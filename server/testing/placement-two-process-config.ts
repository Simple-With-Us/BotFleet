// The contract the two-process placement fixture and its receipt producer
// share (BF-2559 T6b).
//
// One file describes the whole fixture:  where the controller and the worker
// keep their files, which job the controller offers, which nonce the job
// leaves behind, and where each process writes down what it observed.  The
// producer writes that file once and the two child processes read it, so no
// value ever travels on a command line and no credential ever travels in it.
//
// The worker credential is the one secret in the fixture, and it does not
// travel here:  the producer keeps it in a private file of its own and hands
// the child the path.  What travels here is the digest the controller checks
// the presented secret against.
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { HOST_ID_PATTERN, type HostId } from "../../shared/placement.ts";

export const PLACEMENT_FIXTURE_CONFIG_VERSION = 1;

/**
 * One segment of a shell command, quoted for the shell that runs it.
 *
 * The job's command is handed to a shell as one string, so a path with a
 * space in it (an interpreter under Program Files, a temporary directory with
 * a space in its name) is split into the wrong words unless it is quoted.  A
 * single quote is closed, escaped and reopened, which is the one form every
 * POSIX shell reads the same way.
 */
export function quoteShellSegment(segment: string): string {
  return `'${segment.replace(/'/g, "'\\''")}'`;
}

const hostIdSchema = z.string().regex(HOST_ID_PATTERN).transform((value) => {
  // SAFETY: the regex above matched the host id template, so this string is a HostId.
  return value as HostId;
});

/** Everything the two child processes need to run one fixture. */
export const PlacementFixtureConfigSchema = z.strictObject({
  version: z.literal(PLACEMENT_FIXTURE_CONFIG_VERSION),
  controllerId: hostIdSchema,
  workerId: hostIdSchema,
  epoch: z.number().int().nonnegative(),
  credentialId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  /** The digest the controller checks the presented secret against. */
  secretSha256: z.string().regex(/^[0-9a-f]{64}$/),
  controllerDir: z.string().min(1).max(4096),
  workerDir: z.string().min(1).max(4096),
  nonceDir: z.string().min(1).max(4096),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  jobId: z.string().min(1).max(128),
  /** The interpreter the job runs under, as an absolute path. */
  nodePath: z.string().min(1).max(4096),
  nonceScript: z.string().min(1).max(4096),
  /** The private file the worker reads its presented secret from. */
  credentialFile: z.string().min(1).max(4096),
  controllerReadyFile: z.string().min(1).max(4096),
  controllerSummaryFile: z.string().min(1).max(4096),
  workerSummaryFile: z.string().min(1).max(4096),
  timeoutMs: z.number().int().positive().max(600000),
});
export type PlacementFixtureConfig = z.infer<typeof PlacementFixtureConfigSchema>;

/** What the controller process saw and decided, written by the controller. */
export const PlacementControllerSummarySchema = z.strictObject({
  pid: z.number().int().positive(),
  controllerId: hostIdSchema,
  workerId: hostIdSchema,
  epoch: z.number().int().nonnegative(),
  /** The loopback port the worker reached the controller on. */
  port: z.number().int().positive(),
  jobId: z.string().min(1).max(128),
  leaseId: z.string().min(1).max(128).nullable(),
  status: z.string().min(1).max(64),
  reportStatus: z.string().min(1).max(64).nullable(),
  exitCode: z.number().int().nullable(),
});
export type PlacementControllerSummary = z.infer<typeof PlacementControllerSummarySchema>;

/** What the worker process ran, written by the worker. */
export const PlacementWorkerSummarySchema = z.strictObject({
  pid: z.number().int().positive(),
  controllerId: hostIdSchema,
  workerId: hostIdSchema,
  epoch: z.number().int().nonnegative(),
  jobId: z.string().min(1).max(128),
  leaseId: z.string().min(1).max(128).nullable(),
  /** How many job processes the worker's own runner started. */
  spawns: z.number().int().nonnegative(),
  registered: z.boolean(),
  /** Reports the worker still holds undelivered. */
  pendingReports: z.number().int().nonnegative(),
});
export type PlacementWorkerSummary = z.infer<typeof PlacementWorkerSummarySchema>;

/** The private file the worker reads its presented secret from. */
export const PlacementFixtureCredentialSchema = z.strictObject({
  credentialId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  /** The presented secret, in the clear, and only ever inside the fixture. */
  secret: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PlacementFixtureCredential = z.infer<typeof PlacementFixtureCredentialSchema>;

/**
 * Read one JSON file and parse it against its schema.
 *
 * A file that does not parse is a fixture failure, not a fact about
 * placement, so it is refused rather than guessed at.
 */
function readParsed<T>(path: string, schema: z.ZodType<T>, label: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`the ${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`the ${label} is not JSON: ${path}`);
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    const detail = checked.error.issues.map((issue) => `${issue.path.join(".") || label}: ${issue.message}`).join("; ");
    throw new Error(`the ${label} does not match the fixture contract: ${detail}`);
  }
  return checked.data;
}

/** Read the fixture contract. */
export function readFixtureConfig(path: string): PlacementFixtureConfig {
  return readParsed(path, PlacementFixtureConfigSchema, "fixture configuration");
}

/** Write the fixture contract for the children to read. */
export function writeFixtureConfig(path: string, config: PlacementFixtureConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** Read the private credential file. */
export function readFixtureCredential(path: string): PlacementFixtureCredential {
  return readParsed(path, PlacementFixtureCredentialSchema, "fixture credential");
}

/** Write the private credential file the worker presents. */
export function writeFixtureCredential(path: string, credential: PlacementFixtureCredential): void {
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
}

/** Read what the controller process wrote down. */
export function readControllerSummary(path: string): PlacementControllerSummary {
  return readParsed(path, PlacementControllerSummarySchema, "controller summary");
}

/** Read what the worker process wrote down. */
export function readWorkerSummary(path: string): PlacementWorkerSummary {
  return readParsed(path, PlacementWorkerSummarySchema, "worker summary");
}

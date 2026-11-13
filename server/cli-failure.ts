// Turning a failed `recall` child-process call into words a person can act
// on, instead of one fixed "did not answer" sentence regardless of cause.
import { z } from "zod";

import { redactSecretsInText } from "./redact.ts";

/** Maximum bot tool CLI budget; settings probes use their shorter request budget. */
export const RECALL_CLI_TIMEOUT_MS = 30_000;

// What a failed child process looks like, parsed rather than poked at: a
// timeout kills the child (so it shows up as a signal), a non-zero exit
// carries a numeric code, and a failure to start carries a string one.
const cliFailureSchema = z.object({
  killed: z.boolean().optional(),
  signal: z.string().nullish(),
  stderr: z.string().optional(),
  message: z.string().optional(),
});
const cliExitCodeSchema = z.object({ code: z.number() });
const cliSpawnFailureSchema = z.object({ code: z.literal("ENOENT") });

/** A best-effort, always-a-string rendering of a thrown value that carried
 * neither `stderr` nor `message` — a real `execFile` failure is an `Error`
 * and always has one of those, so this only runs for something else
 * entirely (a rejection from an unrelated library, a plain thrown object).
 * `String(err)` on a plain object collapses to the useless "[object
 * Object]", so this tries JSON first and only falls back to that. */
function describeUnknownThrow(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    try {
      const json = JSON.stringify(err);
      // undefined for e.g. a bare function or symbol; empty string never
      // happens for `JSON.stringify` on a defined value.
      if (json) return json;
    } catch {
      // Circular reference or a BigInt field — fall through to String().
    }
  }
  return String(err);
}

/** Why a `recall` CLI call failed, in words a person can act on, and safe to
 * return over the API: no environment values, and anything the child printed
 * goes through the same redaction the chat cards use, because a CLI can echo
 * a URL — or a credential — into its own stderr. */
export function describeCliFailure(err: unknown, timeoutMs: number): string {
  if (err instanceof SyntaxError) return "it printed output that was not JSON";
  const parsed = cliFailureSchema.safeParse(err);
  const failure = parsed.success ? parsed.data : {};
  // execFile kills the child on timeout, so a signal is how a timeout looks
  // from here — there is no distinct error code for it.
  if (failure.killed || failure.signal === "SIGTERM" || failure.signal === "SIGKILL") {
    return `it timed out after ${Math.round(timeoutMs / 1000)}s`;
  }
  if (cliSpawnFailureSchema.safeParse(err).success) return "the executable could not be run";
  const raw = (failure.stderr?.trim() || failure.message || describeUnknownThrow(err)).trim();
  const safe = redactSecretsInText(raw).replace(/\s+/g, " ").trim().slice(0, 300);
  const exit = cliExitCodeSchema.safeParse(err);
  const exited = exit.success ? `it exited ${exit.data.code}` : "it failed";
  return safe ? `${exited}: ${safe}` : exited;
}

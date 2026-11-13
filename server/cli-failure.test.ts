// describeCliFailure turns a failed `recall` child-process call into words a
// person can act on. These pin each branch directly against synthetic error
// shapes — the same shapes execFile/execFileAsync actually throw — rather
// than provoking a real 30-second timeout in a spawned process.
import { describe, expect, it } from "vitest";

import { RECALL_CLI_TIMEOUT_MS, describeCliFailure } from "./cli-failure.ts";

describe("describeCliFailure", () => {
  it("names a genuine timeout instead of a generic failure", () => {
    // execFile kills the child on timeout — this is what the resulting
    // error looks like: killed is true and signal is the kill signal, with
    // no exit code at all. There was no test pinning this branch before.
    const err = { killed: true, signal: "SIGTERM" };
    expect(describeCliFailure(err, RECALL_CLI_TIMEOUT_MS)).toBe("it timed out after 30s");
    expect(describeCliFailure(err, 6_000)).toBe("it timed out after 6s");
  });

  it("also recognises SIGKILL as a timeout", () => {
    expect(describeCliFailure({ killed: true, signal: "SIGKILL" }, 30_000)).toBe("it timed out after 30s");
    // signal alone, without `killed`, is the same story.
    expect(describeCliFailure({ signal: "SIGTERM" }, 30_000)).toBe("it timed out after 30s");
  });

  it("reports a missing executable distinctly from a timeout or a bad exit", () => {
    expect(describeCliFailure({ code: "ENOENT" }, 30_000)).toBe("the executable could not be run");
  });

  it("reports the exit code and redacted stderr for a normal failure", () => {
    const err = { code: 3, stderr: "recall: could not reach the embedder\n" };
    expect(describeCliFailure(err, 30_000)).toBe("it exited 3: recall: could not reach the embedder");
  });

  it("falls back to the error message when stderr is empty", () => {
    const err = { code: 1, message: "spawn recall EACCES" };
    expect(describeCliFailure(err, 30_000)).toBe("it exited 1: spawn recall EACCES");
  });

  it("names unparsable output distinctly", () => {
    expect(describeCliFailure(new SyntaxError("Unexpected token < in JSON"), 30_000)).toBe(
      "it printed output that was not JSON",
    );
  });

  it("renders a non-Error, non-child-process-shaped throw as JSON instead of '[object Object]'", () => {
    // Something that is not an Error and matches none of the known
    // execFile failure shapes — e.g. a rejection value from an unrelated
    // library. String(err) on a plain object collapses to the useless
    // "[object Object]"; this should read the actual fields instead.
    const err = { reason: "econnrefused", port: 6333 };
    const description = describeCliFailure(err, 30_000);
    expect(description).not.toContain("[object Object]");
    expect(description).toContain("econnrefused");
    expect(description).toContain("6333");
  });

  it("still falls back to String() for a value JSON cannot usefully render", () => {
    // A circular object can't be JSON.stringify'd at all; a bigint inside one
    // throws too. Either way this must not throw, and must produce some
    // non-empty description rather than propagating the serialization error.
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => describeCliFailure(circular, 30_000)).not.toThrow();
    expect(describeCliFailure(circular, 30_000)).toContain("it failed");
  });

  it("preserves whatever a bare failure object carries instead of discarding it as '[object Object]'", () => {
    // Neither of these has a `stderr` or `message` field to report, so what
    // little the thrown value does carry — its own shape — is what's left to
    // show; JSON is more useful here than the "[object Object]" the old
    // String(err) fallback produced.
    expect(describeCliFailure({ code: 1 }, 30_000)).toBe('it exited 1: {"code":1}');
    expect(describeCliFailure({}, 30_000)).toBe("it failed: {}");
  });
});

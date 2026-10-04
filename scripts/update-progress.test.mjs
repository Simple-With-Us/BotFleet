// The updater's only channel back to whoever started it.
//
// The transaction coordinator is unchanged and untestable from here without
// a real Mac, so these drive it with a fake operations adapter — the same
// shape `createOperations` returns — and assert on what lands in the file the
// harness reads.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { APPLY_STEPS, applyPreparedUpdate, PREPARE_STEPS, prepareUpdate, UpdateRefusedError } from "./mac-update-transaction.mjs";
import {
  createUpdateProgress,
  instrumentOperations,
  outcomeForError,
  outcomeMessage,
  UPDATE_STEPS,
} from "./update-progress.mjs";

const roots = [];

function progressFile() {
  const root = mkdtempSync(join(tmpdir(), "bf-update-progress-"));
  roots.push(root);
  return join(root, "run.progress.json");
}

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Enough of the operations adapter for the coordinator to walk a whole run. */
function fakeOperations(overrides = {}) {
  const prepared = {
    targetCommit: "b".repeat(40),
    manifestPath: "/stage/prepared.json",
    stageDirectory: "/stage",
  };
  const base = {
    acquireLock: async () => ({ release: async () => {} }),
    resolveTarget: async () => "b".repeat(40),
    prepareSource: async () => ({ stageDirectory: "/stage", path: "/stage/source", temporary: true }),
    assertStagingSource: async () => {},
    installDependencies: async () => {},
    buildBundle: async () => "/stage/BotFleet.app",
    validateBundle: async () => ({ version: "1.0.31" }),
    persistPrepared: async () => prepared,
    releaseSource: async () => {},
    validatePrepared: async () => {},
    preflight: async () => ({ safe: true }),
    capturePrevious: async () => ({ checkoutCommit: "a".repeat(40) }),
    materializeCandidate: async () => {},
    fence: async () => ({ safe: true }),
    quiesce: async () => {},
    assertQuiesced: async () => {},
    advanceCheckout: async () => {},
    installCandidate: async () => {},
    prepareCredentials: async () => {},
    startHarness: async () => {},
    verifyHarness: async () => {},
    startApplication: async () => {},
    verifySingleOwner: async () => {},
    finish: async () => {},
    rollback: async () => {},
    cleanupCandidate: async () => {},
    smokeTestBundle: async () => {},
  };
  // A fixture that quietly omits a step fails at runtime as
  // "ops.<name> is not a function", which reads like a bug in the coordinator
  // rather than an out-of-date fake.  Check it here instead, naming the step.
  for (const step of [...PREPARE_STEPS, ...APPLY_STEPS]) {
    if (step === "acquireLock") continue;
    if (typeof base[step] !== "function") {
      throw new Error(`fakeOperations is missing ${step}; add it so this fixture keeps matching the transaction`);
    }
  }
  return { prepared, operations: { ...base, ...overrides } };
}

describe("the progress file", () => {
  it("names each step as the transaction reaches it, and ends with an outcome", async () => {
    const path = progressFile();
    const progress = createUpdateProgress({ path, runId: "run_one", command: "prepare" });
    const { operations } = fakeOperations();
    await prepareUpdate({ target: "origin/main" }, instrumentOperations(operations, progress));
    progress.finish("verified", "The update was prepared.");

    const record = read(path);
    expect(record.schemaVersion).toBe(1);
    expect(record.runId).toBe("run_one");
    expect(record.command).toBe("prepare");
    expect(record.outcome).toBe("verified");
    expect(record.progress).toBe(1);
    expect(record.finishedAt).toEqual(expect.any(String));
    // The commit and the receipt come from the operations' own return values.
    expect(record.targetCommit).toBe("b".repeat(40));
    expect(record.receiptPath).toBe("/stage/prepared.json");
    expect(record.steps.map((step) => step.name)).toEqual([
      "acquireLock",
      "resolveTarget",
      "prepareSource",
      "assertStagingSource",
      "installDependencies",
      "buildBundle",
      "validateBundle",
      "smokeTestBundle",
      "persistPrepared",
      "releaseSource",
    ]);
    expect(record.steps.every((step) => step.ok === true)).toBe(true);
  });

  it("reports the step it is on while the run is still going", async () => {
    const path = progressFile();
    const progress = createUpdateProgress({ path, runId: "run_one" });
    const seen = [];
    const { operations } = fakeOperations({
      buildBundle: async () => {
        seen.push(read(path));
        return "/stage/BotFleet.app";
      },
    });
    await prepareUpdate({ target: "origin/main" }, instrumentOperations(operations, progress));
    expect(seen[0].step).toBe("buildBundle");
    expect(seen[0].finishedAt).toBeNull();
    expect(seen[0].progress).toBeGreaterThan(0);
    expect(seen[0].progress).toBeLessThan(1);
    expect(seen[0].stepCount).toBe(UPDATE_STEPS.length);
  });

  it("marks the failing step and leaves the rest of the record intact", async () => {
    const path = progressFile();
    const progress = createUpdateProgress({ path, runId: "run_one" });
    const { operations } = fakeOperations({
      installDependencies: async () => {
        throw new Error("pnpm install --frozen-lockfile failed with exit 1");
      },
    });
    await expect(prepareUpdate({ target: "origin/main" }, instrumentOperations(operations, progress)))
      .rejects.toThrow("pnpm install");
    progress.finish("failed", "pnpm install --frozen-lockfile failed with exit 1");
    const record = read(path);
    const failed = record.steps.find((step) => step.name === "installDependencies");
    expect(failed.ok).toBe(false);
    expect(record.outcome).toBe("failed");
  });
});

describe("the reporting channel itself", () => {
  /** A regular file where the progress file's parent directory belongs.  Both
   * the recursive mkdir and the write fail on it, on every OS the suite runs
   * on, so this needs no permission bits and behaves the same on Windows. */
  function blockedPath() {
    const root = mkdtempSync(join(tmpdir(), "bf-update-progress-"));
    roots.push(root);
    const occupied = join(root, "occupied");
    writeFileSync(occupied, "not a directory\n");
    return join(occupied, "run.progress.json");
  }

  it("refuses the run when the first write cannot land", () => {
    expect(() => createUpdateProgress({ path: blockedPath(), runId: "run_one" }))
      .toThrow(/Cannot record update progress/);
  });

  it("aborts before the transaction, so nothing is half-installed unreported", async () => {
    const path = blockedPath();
    const called = [];
    const { operations } = fakeOperations();
    const watched = Object.fromEntries(Object.entries(operations).map(([name, operation]) => [
      name,
      async (...args) => {
        called.push(name);
        return operation(...args);
      },
    ]));
    // The same order `main` uses: make the recorder, instrument the adapter,
    // then run.  The recorder is what the adapter needs, so a channel that
    // cannot be written means no operation ever gets the chance to run.
    await expect((async () => {
      const progress = createUpdateProgress({ path, runId: "run_one" });
      return prepareUpdate({ target: "origin/main" }, instrumentOperations(watched, progress));
    })()).rejects.toThrow(/Cannot record update progress/);
    expect(called).toEqual([]);
  });

  it("keeps the rest of the run going when a later write fails", async () => {
    // Disk full after the channel was proven: the install is already under way
    // and must finish, so every write after the first stays best-effort.
    const seen = [];
    const write = (_target, value) => {
      seen.push(value.step ?? value.outcome ?? null);
      if (seen.length > 1) throw new Error("ENOSPC: no space left on device");
    };
    const progress = createUpdateProgress({ path: "/nowhere/run.progress.json", runId: "run_one", write });
    const { operations } = fakeOperations();
    await prepareUpdate({ target: "origin/main" }, instrumentOperations(operations, progress));
    progress.finish("verified", "The update was prepared.");
    expect(seen.length).toBeGreaterThan(1);
    expect(progress.record.outcome).toBe("verified");
    expect(progress.record.steps.at(-1).name).toBe("releaseSource");
  });
});

describe("which outcome a failure is", () => {
  it("calls a completed rollback rolled-back, whatever threw", () => {
    expect(outcomeForError(new Error("codesign failed"), { rolledBack: true })).toBe("rolled-back");
  });

  it("calls the transaction's own refusal refused, through an AggregateError", () => {
    expect(outcomeForError(new UpdateRefusedError("work is in flight"))).toBe("refused");
    const aggregate = new AggregateError([new UpdateRefusedError("work is in flight"), new Error("x")], "both");
    expect(outcomeForError(aggregate)).toBe("refused");
  });

  it("calls everything else failed", () => {
    expect(outcomeForError(new Error("git fetch failed"))).toBe("failed");
    expect(outcomeForError(undefined)).toBe("failed");
  });

  it("keeps the first line only, so a command dump never reaches the phone", () => {
    expect(outcomeMessage(new Error("first line\nsecond line"))).toBe("first line");
    expect(outcomeMessage(new Error("x".repeat(900))).length).toBe(400);
    expect(outcomeMessage(undefined)).toBe("The update failed.");
  });
});

describe("crossing the interruption boundary", () => {
  it("records that the run reached the point where it stops BotFleet", async () => {
    const path = progressFile();
    const progress = createUpdateProgress({ path, runId: "run_one", command: "apply" });
    const { prepared, operations } = fakeOperations();
    await applyPreparedUpdate(prepared, { openApplication: true }, instrumentOperations(operations, progress));
    const record = read(path);
    expect(record.crossedBoundary).toBe(true);
    expect(record.steps.map((step) => step.name)).toContain("quiesce");
    // Both preflights are recorded, and the fraction still counts the step once.
    expect(record.steps.filter((step) => step.name === "preflight")).toHaveLength(2);
  });

  it("records a rollback so the outcome can say so", async () => {
    const path = progressFile();
    const progress = createUpdateProgress({ path, runId: "run_one", command: "apply" });
    const { prepared, operations } = fakeOperations({
      startHarness: async () => {
        throw new Error("the harness did not come back");
      },
    });
    await expect(applyPreparedUpdate(prepared, {}, instrumentOperations(operations, progress)))
      .rejects.toThrow("did not come back");
    expect(progress.record.rolledBack).toBe(true);
    expect(outcomeForError(new Error("the harness did not come back"), { rolledBack: progress.record.rolledBack }))
      .toBe("rolled-back");
  });

  it("does not claim a rollback when the refusal came before the boundary", async () => {
    const path = progressFile();
    const progress = createUpdateProgress({ path, runId: "run_one", command: "apply" });
    const { prepared, operations } = fakeOperations({ preflight: async () => ({ safe: false, reason: "a turn is running" }) });
    await expect(applyPreparedUpdate(prepared, {}, instrumentOperations(operations, progress)))
      .rejects.toThrow("a turn is running");
    expect(progress.record.rolledBack).toBe(false);
    expect(progress.record.crossedBoundary).toBe(false);
  });
});

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  UpdateRefusedError,
  applyPreparedUpdate,
  prepareUpdate,
} from "./mac-update-transaction.mjs";

const prepared = {
  targetCommit: "b".repeat(40),
  stageDirectory: "/stage",
  bundlePath: "/stage/BotFleet.app",
};

function fakeApplyOps({ readiness = [{ safe: true }, { safe: true }], failAt } = {}) {
  const calls = [];
  const previous = { checkoutCommit: "a".repeat(40), appWasRunning: true };
  const step = async (name, value) => {
    calls.push(name);
    if (failAt === name) throw new Error(`${name} failed`);
    return value;
  };
  return {
    calls,
    previous,
    ops: {
      acquireLock: () => step("lock", { release: () => step("unlock") }),
      validatePrepared: () => step("validatePrepared"),
      preflight: () => step("preflight", readiness.shift() ?? { safe: true }),
      capturePrevious: () => step("capturePrevious", previous),
      materializeCandidate: () => step("materializeCandidate"),
      cleanupCandidate: () => step("cleanupCandidate"),
      quiesce: () => step("quiesce"),
      assertQuiesced: () => step("assertQuiesced"),
      advanceCheckout: () => step("advanceCheckout"),
      installCandidate: () => step("installCandidate"),
      startHarness: () => step("startHarness"),
      verifyHarness: () => step("verifyHarness"),
      startApplication: () => step("startApplication"),
      verifySingleOwner: () => step("verifySingleOwner"),
      finish: () => step("finish"),
      rollback: () => step("rollback"),
    },
  };
}

test("active work refuses before any live mutation", async () => {
  const fake = fakeApplyOps({ readiness: [{ safe: false, reason: "2 active operations" }] });
  await assert.rejects(
    applyPreparedUpdate(prepared, {}, fake.ops),
    (error) => error instanceof UpdateRefusedError && /2 active operations/.test(error.message),
  );
  assert.deepEqual(fake.calls, ["lock", "validatePrepared", "preflight", "unlock"]);
});

test("readiness is rechecked immediately before quiescing", async () => {
  const fake = fakeApplyOps({
    readiness: [{ safe: true }, { safe: false, reason: "work started during staging" }],
  });
  await assert.rejects(applyPreparedUpdate(prepared, {}, fake.ops), /work started during staging/);
  assert.deepEqual(fake.calls, [
    "lock",
    "validatePrepared",
    "preflight",
    "capturePrevious",
    "materializeCandidate",
    "preflight",
    "cleanupCandidate",
    "unlock",
  ]);
});

test("a candidate copy failure cleans partial files without crossing the live boundary", async () => {
  const fake = fakeApplyOps({ failAt: "materializeCandidate" });
  await assert.rejects(applyPreparedUpdate(prepared, {}, fake.ops), /materializeCandidate failed/);
  assert.deepEqual(fake.calls, [
    "lock",
    "validatePrepared",
    "preflight",
    "capturePrevious",
    "materializeCandidate",
    "cleanupCandidate",
    "unlock",
  ]);
  assert.equal(fake.calls.includes("quiesce"), false);
  assert.equal(fake.calls.includes("rollback"), false);
});

test("candidate cleanup failure preserves the refusal and cleanup errors", async () => {
  const fake = fakeApplyOps({
    readiness: [{ safe: true }, { safe: false, reason: "work started during staging" }],
  });
  fake.ops.cleanupCandidate = async () => {
    fake.calls.push("cleanupCandidate");
    throw new Error("cleanup failed");
  };
  await assert.rejects(
    applyPreparedUpdate(prepared, {}, fake.ops),
    (error) => error instanceof AggregateError && error.errors.length === 2 &&
      /work started during staging/.test(error.errors[0].message) && /cleanup failed/.test(error.errors[1].message),
  );
});

for (const failAt of ["quiesce", "assertQuiesced", "advanceCheckout", "installCandidate", "startHarness", "verifyHarness", "startApplication", "verifySingleOwner"]) {
  test(`a ${failAt} failure rolls the prior bundle and checkout back`, async () => {
    const fake = fakeApplyOps({ failAt });
    await assert.rejects(applyPreparedUpdate(prepared, {}, fake.ops), new RegExp(`${failAt} failed`));
    assert.ok(fake.calls.includes("rollback"));
    assert.ok(fake.calls.indexOf("rollback") > fake.calls.indexOf(failAt));
    assert.equal(fake.calls.at(-1), "unlock");
  });
}

test("a rollback failure preserves both errors", async () => {
  const fake = fakeApplyOps({ failAt: "installCandidate" });
  fake.ops.rollback = async () => {
    fake.calls.push("rollback");
    throw new Error("rollback failed");
  };
  await assert.rejects(
    applyPreparedUpdate(prepared, {}, fake.ops),
    (error) => error instanceof AggregateError && /rollback also failed/.test(error.message) && error.errors.length === 2,
  );
});

test("successful apply verifies the expected harness before reopening and ownership after", async () => {
  const fake = fakeApplyOps();
  const result = await applyPreparedUpdate(prepared, { openApplication: true }, fake.ops);
  assert.deepEqual(result, {
    targetCommit: "b".repeat(40),
    previousCommit: "a".repeat(40),
  });
  assert.ok(fake.calls.indexOf("verifyHarness") < fake.calls.indexOf("startApplication"));
  assert.ok(fake.calls.indexOf("startApplication") < fake.calls.indexOf("verifySingleOwner"));
  assert.ok(fake.calls.indexOf("finish") < fake.calls.indexOf("unlock"));
  assert.equal(fake.calls.includes("rollback"), false);
});

test("prepare validates completely before publishing a reusable stage", async () => {
  const calls = [];
  const step = async (name, value) => {
    calls.push(name);
    return value;
  };
  const result = await prepareUpdate(
    { target: "origin/main" },
    {
      acquireLock: () => step("lock", { release: () => step("unlock") }),
      resolveTarget: () => step("resolveTarget", prepared.targetCommit),
      prepareSource: () => step("prepareSource", { path: "/stage/source", temporary: true }),
      assertStagingSource: () => step("assertStagingSource"),
      installDependencies: () => step("installDependencies"),
      buildBundle: () => step("buildBundle", "/stage/source/release/mac-arm64/BotFleet.app"),
      validateBundle: () => step("validateBundle", { teamIdentifier: "CC8UTF7ATG" }),
      persistPrepared: () => step("persistPrepared", prepared),
      releaseSource: () => step("releaseSource"),
    },
  );
  assert.equal(result, prepared);
  assert.deepEqual(calls, [
    "lock",
    "resolveTarget",
    "prepareSource",
    "assertStagingSource",
    "installDependencies",
    "buildBundle",
    "validateBundle",
    "persistPrepared",
    "releaseSource",
    "unlock",
  ]);
});

test("a staging build failure cannot reach any live operation", async () => {
  const calls = [];
  await assert.rejects(
    prepareUpdate(
      {},
      {
        acquireLock: async () => ({ release: async () => calls.push("unlock") }),
        resolveTarget: async () => "b".repeat(40),
        prepareSource: async () => ({ path: "/stage/source", temporary: true }),
        assertStagingSource: async () => calls.push("assertStagingSource"),
        installDependencies: async () => calls.push("installDependencies"),
        buildBundle: async () => {
          calls.push("buildBundle");
          throw new Error("package failed");
        },
        validateBundle: async () => calls.push("validateBundle"),
        persistPrepared: async () => calls.push("persistPrepared"),
        releaseSource: async () => calls.push("releaseSource"),
      },
    ),
    /package failed/,
  );
  assert.deepEqual(calls, ["assertStagingSource", "installDependencies", "buildBundle", "releaseSource", "unlock"]);
});

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
      fence: () => step("fence", { safe: true }),
      cleanupCandidate: () => step("cleanupCandidate"),
      quiesce: () => step("quiesce"),
      assertQuiesced: () => step("assertQuiesced"),
      advanceCheckout: () => step("advanceCheckout"),
      installCandidate: () => step("installCandidate"),
      prepareCredentials: () => step("prepareCredentials"),
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

test("work arriving before the admission fence refuses without crossing the live boundary", async () => {
  const fake = fakeApplyOps();
  fake.ops.fence = () => {
    fake.calls.push("fence");
    return Promise.resolve({ safe: false, reason: "work entered before fence" });
  };
  await assert.rejects(applyPreparedUpdate(prepared, {}, fake.ops), /work entered before fence/);
  assert.deepEqual(fake.calls, [
    "lock", "validatePrepared", "preflight", "capturePrevious", "materializeCandidate", "preflight", "fence",
    "cleanupCandidate", "unlock",
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

for (const failAt of ["quiesce", "assertQuiesced", "advanceCheckout", "installCandidate", "prepareCredentials", "startHarness", "verifyHarness", "startApplication", "verifySingleOwner"]) {
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
  assert.ok(fake.calls.indexOf("fence") < fake.calls.indexOf("quiesce"));
  assert.ok(fake.calls.indexOf("installCandidate") < fake.calls.indexOf("prepareCredentials"));
  assert.ok(fake.calls.indexOf("prepareCredentials") < fake.calls.indexOf("startHarness"));
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
      smokeTestBundle: () => step("smokeTestBundle"),
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
    "smokeTestBundle",
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
        smokeTestBundle: async () => calls.push("smokeTestBundle"),
        persistPrepared: async () => calls.push("persistPrepared"),
        releaseSource: async () => calls.push("releaseSource"),
      },
    ),
    /package failed/,
  );
  assert.deepEqual(calls, ["assertStagingSource", "installDependencies", "buildBundle", "releaseSource", "unlock"]);
});

test("a staging-source cleanup failure still releases the updater lock", async () => {
  const calls = [];
  await assert.rejects(
    prepareUpdate(
      {},
      {
        acquireLock: async () => ({ release: async () => calls.push("unlock") }),
        resolveTarget: async () => "b".repeat(40),
        prepareSource: async () => ({ path: "/stage/source", temporary: true }),
        assertStagingSource: async () => {},
        installDependencies: async () => {},
        buildBundle: async () => "/stage/source/release/mac-arm64/BotFleet.app",
        validateBundle: async () => ({ teamIdentifier: "CC8UTF7ATG" }),
        smokeTestBundle: async () => {},
        persistPrepared: async () => prepared,
        releaseSource: async () => {
          calls.push("releaseSource");
          throw new Error("source cleanup failed");
        },
      },
    ),
    /source cleanup failed/,
  );
  assert.deepEqual(calls, ["releaseSource", "unlock"]);
});

// The staged candidate is proved by RUNNING it, in the one phase that still
// touches nothing live.  These two cases pin that placement: the probe runs
// after signature validation and before the stage is published, and a failing
// probe never reaches persistPrepared.
test("the candidate is proved to start after validation and before the stage is published", async () => {
  const calls = [];
  const step = async (name, value) => {
    calls.push(name);
    return value;
  };
  await prepareUpdate(
    { target: "origin/main" },
    {
      acquireLock: () => step("lock", { release: () => step("unlock") }),
      resolveTarget: () => step("resolveTarget", prepared.targetCommit),
      prepareSource: () => step("prepareSource", { path: "/stage/source", temporary: true }),
      assertStagingSource: () => step("assertStagingSource"),
      installDependencies: () => step("installDependencies"),
      buildBundle: () => step("buildBundle", "/stage/source/release/mac-arm64/BotFleet.app"),
      validateBundle: () => step("validateBundle", { teamIdentifier: "CC8UTF7ATG" }),
      smokeTestBundle: () => step("smokeTestBundle"),
      persistPrepared: () => step("persistPrepared", prepared),
      releaseSource: () => step("releaseSource"),
    },
  );
  assert.ok(calls.indexOf("validateBundle") < calls.indexOf("smokeTestBundle"));
  assert.ok(calls.indexOf("smokeTestBundle") < calls.indexOf("persistPrepared"));
});

test("a candidate that will not start is never published as a reusable stage", async () => {
  const calls = [];
  await assert.rejects(
    prepareUpdate(
      { target: "origin/main" },
      {
        acquireLock: async () => ({ release: async () => calls.push("unlock") }),
        resolveTarget: async () => "b".repeat(40),
        prepareSource: async () => ({ path: "/stage/source", temporary: true }),
        assertStagingSource: async () => calls.push("assertStagingSource"),
        installDependencies: async () => calls.push("installDependencies"),
        buildBundle: async () => "/stage/source/release/mac-arm64/BotFleet.app",
        validateBundle: async () => ({ teamIdentifier: "CC8UTF7ATG" }),
        smokeTestBundle: async () => {
          calls.push("smokeTestBundle");
          throw new Error("Staged BotFleet candidate never reported ready");
        },
        persistPrepared: async () => calls.push("persistPrepared"),
        releaseSource: async () => calls.push("releaseSource"),
      },
    ),
    /never reported ready/,
  );
  // No stage is published, and the staging source is still released.  Nothing
  // live was touched at any point, so there is nothing to roll back.
  assert.deepEqual(calls, ["assertStagingSource", "installDependencies", "smokeTestBundle", "releaseSource", "unlock"]);
});

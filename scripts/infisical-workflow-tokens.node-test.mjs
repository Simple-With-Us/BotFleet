// Each Infisical step in these workflows passes the scoped read token named
// by its consumer in scripts/infisical-binding-preflight.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";
import { bindings } from "./infisical-binding-preflight.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Step name -> consumer name in scripts/infisical-binding-preflight.mjs. */
const STEP_CONSUMERS = {
  "native-mac-release.yml": {
    "Load the App Store Connect credentials": "native-mac-build-plan",
    "Load the Developer ID certificate": "native-mac-developer-id-certificate",
    "Load the Sentry DSN (optional)": "native-mac-sentry",
    "Load the notarization credentials": "native-mac-notarization",
    "Load the Sparkle EdDSA key (optional)": "native-mac-sparkle-appcast",
  },
  "release.yml": {
    "Load the App Store Connect credentials": "electron-build-plan",
    "Load the Developer ID certificate": "electron-developer-id-certificate",
    "Resolve the Sentry DSN": "electron-sentry-build",
    "Load the notarization credentials": "electron-notarization",
  },
  "mac-commit-build.yml": {
    "Load the App Store Connect credentials": "mac-commit-build-plan",
    "Load the Developer ID certificate": "mac-commit-developer-id-certificate",
  },
  "sentry-testflight.yml": {
    "Load the required Sentry auth token": "sentry-testflight-report",
  },
};

function bindingFor(consumerName) {
  const binding = bindings.find((row) => row.consumers.some((consumer) => consumer.name === consumerName));
  assert.ok(binding, `preflight bindings name ${consumerName}`);
  return {
    binding,
    consumer: binding.consumers.find((row) => row.name === consumerName),
  };
}

function tokenExpression(bindingName, consumerName) {
  // The reusable reporter accepts a caller token and otherwise reads its own secret.
  if (consumerName === "sentry-testflight-report") {
    return `\${{ inputs.token || secrets.${bindingName} }}`;
  }
  return `\${{ secrets.${bindingName} }}`;
}

function infisicalSteps(doc) {
  const found = [];
  for (const job of Object.values(doc.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.uses === "./.github/actions/infisical-secrets") found.push(step);
    }
  }
  return found;
}

test("packaging workflows pass the scoped read token and no universal-auth identity", () => {
  for (const [file, consumersByStep] of Object.entries(STEP_CONSUMERS)) {
    const text = readFileSync(join(ROOT, ".github/workflows", file), "utf8");
    assert.doesNotMatch(text, /^\s+client-id:/m, `${file} still passes client-id`);
    assert.doesNotMatch(text, /^\s+client-secret:/m, `${file} still passes client-secret`);
    assert.doesNotMatch(text, /INFISICAL_UNIVERSAL_AUTH_/, `${file} still names the universal-auth identity`);
    assert.doesNotMatch(text, /INFISICAL_CLIENT_(?:ID|SECRET)/, `${file} still names the machine identity`);
    const steps = infisicalSteps(parse(text));
    assert.deepEqual(
      steps.map((step) => step.name).sort(),
      Object.keys(consumersByStep).sort(),
      `${file} infisical steps`,
    );
    for (const step of steps) {
      const consumerName = consumersByStep[step.name];
      const { binding, consumer } = bindingFor(consumerName);
      const names = String(step.with?.names ?? "").split(/[\s,]+/).filter(Boolean).sort();
      assert.deepEqual(names, [...consumer.keys].sort(), `${file} ${step.name} names`);
      assert.equal(step.with?.token, tokenExpression(binding.name, consumerName), `${file} ${step.name} token`);
      assert.equal(step.with?.["client-id"], undefined, `${file} ${step.name} client-id`);
      assert.equal(step.with?.["client-secret"], undefined, `${file} ${step.name} client-secret`);
      assert.equal(step.with?.["project-id"], "${{ secrets.INFISICAL_PROJECT_ID }}");
    }
  }

  // ios-ship.yml is the only caller.  It inherits repo secrets, which
  // supplies INFISICAL_SENTRY_TESTFLIGHT_READ_TOKEN and INFISICAL_PROJECT_ID.
  const called = parse(readFileSync(join(ROOT, ".github/workflows/sentry-testflight.yml"), "utf8"));
  assert.equal(called.on.workflow_call.secrets, undefined);
  const caller = parse(readFileSync(join(ROOT, ".github/workflows/ios-ship.yml"), "utf8"));
  const report = caller.jobs["report-sentry-deployment"];
  assert.equal(report.uses, "./.github/workflows/sentry-testflight.yml");
  assert.equal(report.secrets, "inherit");
  assert.equal(report.with?.token, undefined);
  assert.equal(report.secrets?.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID, undefined);
  assert.equal(report.secrets?.INFISICAL_CLIENT_ID, undefined);
});

test("CI runs the scoped-token workflow contract", () => {
  // vitest does not collect *.node-test.mjs.  Hosted CI runs `pnpm test`,
  // which only reaches a node:test file that package.json names.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts["test:infisical-fetch"], /scripts\/infisical-workflow-tokens\.node-test\.mjs/);
  assert.match(pkg.scripts.test, /pnpm test:infisical-fetch/);
});

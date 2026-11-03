import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("every managed action caller supplies a scoped token and no machine identity input", () => {
  const paths = readdirSync(join(ROOT, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name));
  let callers = 0;
  for (const path of paths) {
    const workflow = parse(read(`.github/workflows/${path}`));
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses !== "./.github/actions/infisical-secrets") continue;
        callers++;
        assert.ok(step.with?.token, `${path}: ${step.name} is missing a service token binding`);
        assert.equal(step.with?.["client-id"], undefined, path);
        assert.equal(step.with?.["client-secret"], undefined, path);
        assert.ok(step.with?.["project-id"], `${path}: project locator is missing`);
      }
    }
    assert.doesNotMatch(read(`.github/workflows/${path}`), /secrets\.INFISICAL_(?:AUTOMATION_|UNIVERSAL_AUTH_|CLIENT_)/);
  }
  assert.ok(callers >= 15, "the audit must inspect the fleet's actual workflow callers");
});

test("native release and Vercel catch-up use their dedicated pending bindings", () => {
  const native = parse(read(".github/workflows/native-mac-release.yml"));
  for (const job of Object.values(native.jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses === "./.github/actions/infisical-secrets") assert.equal(step.with.token, "${{ secrets.INFISICAL_NATIVE_RELEASE_READ_TOKEN }}");
    }
  }
  const vercel = parse(read(".github/workflows/vercel-catch-up.yml"));
  const fetchStep = vercel.jobs.deploy.steps.find((step) => step.run === "node scripts/infisical-fetch.mjs");
  assert.equal(fetchStep.env.INFISICAL_TOKEN, "${{ secrets.INFISICAL_VERCEL_CATCH_UP_READ_TOKEN }}");
  assert.equal(fetchStep.env.INFISICAL_ENVIRONMENT, "prod");
  assert.equal(fetchStep.env.INFISICAL_SECRET_PATH, "/");
  assert.equal(fetchStep.env.INFISICAL_NAMES, "VERCEL_TOKEN");
  assert.equal(fetchStep.env.INFISICAL_REQUIRED, "VERCEL_TOKEN");
});

test("managed helpers have no universal-auth implementation or Automation lookup", () => {
  const action = parse(read(".github/actions/infisical-secrets/action.yml"));
  assert.equal(action.inputs["client-id"], undefined);
  assert.equal(action.inputs["client-secret"], undefined);
  assert.equal(action.runs.steps[0].env.INFISICAL_CLIENT_ID, undefined);
  assert.equal(action.runs.steps[0].env.INFISICAL_CLIENT_SECRET, undefined);
  assert.doesNotMatch(read("scripts/infisical-fetch.mjs"), /loginUniversalAuth|universal-auth\/login|env\.INFISICAL_CLIENT_/);
  assert.doesNotMatch(read("scripts/infisical-migrate.mjs"), /loginImpl|login\(/);
  const launcher = read("scripts/botfleet-server-start.sh");
  assert.doesNotMatch(launcher, /INFISICAL_AUTOMATION_CLIENT_|first_fleet_secret INFISICAL_CLIENT_/);
  assert.match(launcher, /first_fleet_secret BOTFLEET_HARNESS_INFISICAL_READ_TOKEN/);
  assert.match(launcher, /first_fleet_secret BOTFLEET_HARNESS_INFISICAL_WRITE_TOKEN/);
});

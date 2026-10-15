import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const renovatePath = join(repoRoot, "renovate.json");

describe("renovate.json", () => {
  test("non-major group verifies frozen lockfile after lockfile regen", () => {
    const config = JSON.parse(readFileSync(renovatePath, "utf8"));
    const nonMajor = config.packageRules?.find((rule) => rule.groupName === "non-major dependencies");
    assert.ok(nonMajor, "expected a non-major dependencies packageRule");
    const tasks = nonMajor.postUpgradeTasks;
    assert.ok(tasks, "non-major group must run postUpgradeTasks");
    assert.equal(tasks.executionMode, "branch");
    assert.ok(
      tasks.commands?.some((command) => command.includes("pnpm install") && command.includes("--frozen-lockfile")),
      "postUpgradeTasks must run pnpm install --frozen-lockfile",
    );
  });
});

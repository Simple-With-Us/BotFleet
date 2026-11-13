import { expect, it } from "vitest";
import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV } from "./config.ts";
import { cliProbeEnvironment } from "./cli-probe-env.ts";

it("removes every restored workspace secret and provider key without mutating the harness env", () => {
  const names = [...WORKSPACE_CREDENTIAL_ENV, ...PROVIDER_CREDENTIAL_ENV];
  const source: NodeJS.ProcessEnv = { ...Object.fromEntries(names.map((name) => [name, "fixture-only"])), HOME: "/fixture", LANG: "en_US.UTF-8" };
  const result = cliProbeEnvironment(source);
  for (const name of names) {
    expect(result[name], name).toBeUndefined();
    expect(source[name]).toBe("fixture-only");
  }
  expect(result.HOME).toBe("/fixture");
  expect(result.LANG).toBe("en_US.UTF-8");
  expect(result.PATH).toBeTruthy();
});

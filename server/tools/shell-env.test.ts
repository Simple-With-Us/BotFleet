import { describe, expect, it } from "vitest";
import { modelShellEnv } from "./shell-env.ts";

describe("bot-reachable child environment", () => {
  it("allows only operating-system basics, not harness or provider credentials", () => {
    const env = modelShellEnv({
      PATH: "/bin", HOME: "/tmp/home", LANG: "en_US.UTF-8",
      INFISICAL_CLIENT_SECRET: "synthetic-vault-secret",
      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "synthetic-vault-alias",
      OPENAI_API_KEY: "synthetic-provider-key", BOX_TOKEN: "synthetic-box-key",
      RANDOM_NEW_SECRET: "synthetic-unknown-secret",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/tmp/home", LANG: "en_US.UTF-8" });
  });
});

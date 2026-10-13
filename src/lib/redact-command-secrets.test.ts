import { describe, expect, it } from "vitest";

import { redactCommandSecrets } from "./redact-command-secrets";

describe("redactCommandSecrets", () => {
  it("scrubs viewer passwords and other credential-shaped env pairs", () => {
    const raw = "docker run -e VNC_PW=secret123 -e API_TOKEN=abc --cpus 3";
    expect(redactCommandSecrets(raw)).toBe("docker run -e VNC_PW=<redacted> -e API_TOKEN=<redacted> --cpus 3");
    expect(redactCommandSecrets(raw)).not.toContain("secret123");
  });
});

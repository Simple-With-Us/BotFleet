import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyNativeProbe } from "./native-version-probe.mjs";

describe("classifyNativeProbe", () => {
  it("matches version from stdout only, ignoring stderr noise", () => {
    const probe = classifyNativeProbe(
      {
        status: 0,
        stdout: "12345\n",
        stderr: "AppImage runtime warning\n",
      },
      (stdout) => (/^\d+$/.test(String(stdout).trim()) ? String(stdout).trim() : null),
    );
    assert.equal(probe.ok, true);
    assert.equal(probe.version, "12345");
  });

  it("does not treat a version mention on stderr as a match", () => {
    const probe = classifyNativeProbe(
      {
        status: 0,
        stdout: "cloudflared version 2026.2.0 (abc)\n",
        stderr: `cloudflared version 2026.7.1\n`,
      },
      (stdout) =>
        String(stdout).startsWith("cloudflared version 2026.2.0 ") ? "2026.2.0" : null,
    );
    assert.equal(probe.ok, true);
    assert.equal(probe.version, "2026.2.0");
  });
});

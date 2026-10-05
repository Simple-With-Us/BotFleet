import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DockerConfigSchema,
  hostCliCredentialMounts,
  manifestCredentialCandidates,
  planCredentialSync,
  sanitizeDockerConfigForLinux,
} from "./vm-cli-credentials.ts";

describe("vm CLI credential sync", () => {
  it("derives mount candidates from the manifest", () => {
    const names = new Set(manifestCredentialCandidates().map((entry) => entry.tool));
    expect(names.has("docker")).toBe(true);
    expect(names.has("turso")).toBe(true);
    expect(names.has("infisical")).toBe(true);
    for (const candidate of manifestCredentialCandidates()) {
      expect(candidate.guest.startsWith("/home/cua/") || candidate.guest === "/home/cua/.gitconfig").toBe(true);
    }
  });

  it("strips macOS docker credential helpers for Linux guests", () => {
    const sanitized = sanitizeDockerConfigForLinux(
      JSON.stringify({
        credsStore: "osxkeychain",
        credHelpers: { "https://index.docker.io/v1/": "osxkeychain", "ghcr.io": "pass" },
      }),
    );
    const parsed = DockerConfigSchema.parse(JSON.parse(sanitized));
    expect(parsed.credsStore).toBeUndefined();
    expect(parsed.credHelpers).toEqual({ "ghcr.io": "pass" });
  });

  it("rejects malformed docker config at the trust boundary", () => {
    expect(() => sanitizeDockerConfigForLinux("null")).toThrow();
  });

  it("reports synced and skipped tools without requiring every path to exist", () => {
    const home = mkdtempSync(join(tmpdir(), "bf-cred-plan-"));
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "config"), "Host *\n");
    try {
      const plan = planCredentialSync({ homeDir: home });
      expect(plan.syncedTools.some((entry) => entry.name === "ssh")).toBe(true);
      expect(plan.skippedTools.some((entry) => entry.name === "turso")).toBe(true);
      const mounts = hostCliCredentialMounts("darwin", home);
      expect(mounts.some((mount) => mount.includes(".ssh"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

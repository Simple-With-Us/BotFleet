import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allowedCliGuestDestinations,
  DockerConfigSchema,
  hostCliCredentialMounts,
  manifestCredentialCandidates,
  planCredentialSync,
  resolveCredentialMountSource,
  sanitizeDockerConfigForLinux,
} from "./vm-cli-credentials.ts";

describe("vm CLI credential sync", () => {
  it("derives mount candidates from the manifest", () => {
    const candidates = manifestCredentialCandidates();
    const names = new Set(candidates.map((entry) => entry.tool));
    expect(names.has("docker")).toBe(true);
    expect(names.has("turso")).toBe(true);
    expect(names.has("infisical")).toBe(true);
    const guests = new Set(candidates.map((entry) => entry.guest));
    expect(guests.has("/home/cua/.turso")).toBe(true);
    expect(guests.has("/home/cua/.kodus")).toBe(true);
    expect(guests.has("/home/cua/.config/cf")).toBe(true);
    expect(guests.has("/home/cua/.cf")).toBe(true);
    for (const candidate of candidates) {
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

  it("allows legacy guest mount destinations for existing containers", () => {
    const allowed = allowedCliGuestDestinations();
    expect(allowed.has("/home/cua/.oci")).toBe(true);
    expect(allowed.has("/home/cua/.terraform.d")).toBe(true);
    expect(allowed.has("/home/cua/.sentryclirc")).toBe(true);
  });

  it("records invalid docker config as a skipped tool during sync planning", () => {
    const home = mkdtempSync(join(tmpdir(), "bf-cred-docker-plan-"));
    mkdirSync(join(home, ".docker"), { recursive: true });
    writeFileSync(join(home, ".docker", "config.json"), "[]");
    const stagingDir = mkdtempSync(join(tmpdir(), "bf-cred-stage-plan-"));
    try {
      const plan = planCredentialSync({ homeDir: home, stagingDir });
      expect(plan.skippedTools.some((entry) => entry.name === "docker")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(stagingDir, { recursive: true, force: true });
    }
  });

  it("skips malformed docker config instead of aborting credential mounts", () => {
    const home = mkdtempSync(join(tmpdir(), "bf-cred-docker-"));
    mkdirSync(join(home, ".docker"), { recursive: true });
    writeFileSync(join(home, ".docker", "config.json"), "[]");
    try {
      const dockerCandidate = manifestCredentialCandidates().find((entry) => entry.transform === "docker-linux-config");
      expect(dockerCandidate).toBeDefined();
      const stagingRoot = mkdtempSync(join(tmpdir(), "bf-staging-docker-"));
      const source = resolveCredentialMountSource(home, dockerCandidate!, stagingRoot, {});
      expect(source).toBeNull();
      expect(() => hostCliCredentialMounts("darwin", home)).not.toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

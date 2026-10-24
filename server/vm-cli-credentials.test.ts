import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allowedCliGuestDestinations,
  credentialSyncExcludePatterns,
  DockerConfigSchema,
  guestCredentialOwnershipRepairShell,
  hostCliCredentialMounts,
  listArchiveRelPaths,
  manifestCredentialCandidates,
  packageCredentialArchive,
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

  // gcloud writes a dated debug log tree under ~/.config/gcloud/logs.  It is
  // not a credential, the guest cannot write it (its ~/.config/gcloud is
  // root-owned), and including it made every VPS credential sync abort.
  it("declares manifest-level excludes covering gcloud's non-credential churn", () => {
    const excludes = credentialSyncExcludePatterns();
    expect(excludes.length).toBeGreaterThan(0);
    for (const pattern of [".config/gcloud/logs", ".config/gcloud/cache", ".config/gcloud/data"]) {
      expect(excludes).toContain(pattern);
    }
  });

  it("repairs guest ownership by removing only paths the guest user does not own", () => {
    const shell = guestCredentialOwnershipRepairShell(["/home/cua/.config/gcloud/logs", "/home/cua/.ssh"]);
    expect(shell).toContain(`id -u cua`);
    expect(shell).toContain("stat -c %u");
    expect(shell).toContain("rm -rf");
    // Both destinations are named, and nothing else is: this runs as root, so
    // an over-broad pattern would delete a guest's own state.
    expect(shell).toContain("'/home/cua/.config/gcloud/logs'");
    expect(shell).toContain("'/home/cua/.ssh'");
    expect(shell).toContain("|| true");
  });

  it("quotes a guest path that carries a single quote", () => {
    const shell = guestCredentialOwnershipRepairShell(["/home/cua/.config/o'brien"]);
    expect(shell).toContain(`'/home/cua/.config/o'\\''brien'`);
  });

  it("does no guest work at all when there is nothing to repair", () => {
    expect(guestCredentialOwnershipRepairShell([])).toBe("exit 0");
  });

  it("packs gcloud credentials without its log and cache churn", async () => {
    const home = mkdtempSync(join(tmpdir(), "bf-cred-gcloud-"));
    try {
      mkdirSync(join(home, ".config", "gcloud", "logs", "2026.10.07"), { recursive: true });
      mkdirSync(join(home, ".config", "gcloud", "cache"), { recursive: true });
      mkdirSync(join(home, ".config", "gcloud", "data"), { recursive: true });
      writeFileSync(join(home, ".config", "gcloud", "credentials.db"), "credential-bytes");
      writeFileSync(join(home, ".config", "gcloud", "logs", "2026.10.07", "run.log"), "debug-chatter");
      writeFileSync(join(home, ".config", "gcloud", "cache", "blob"), "cached-blob");
      writeFileSync(join(home, ".config", "gcloud", "data", "state"), "cli-state");

      const plan = planCredentialSync({ homeDir: home });
      expect(plan.archiveRelPaths).toContain(".config/gcloud");

      const archive = await packageCredentialArchive(home, plan);
      expect(archive).not.toBeNull();
      const listing = spawnSync("tar", ["-tf", "-"], { input: archive! }).stdout.toString();
      expect(listing).toContain(".config/gcloud/credentials.db");
      expect(listing).not.toContain(".config/gcloud/logs");
      expect(listing).not.toContain(".config/gcloud/cache");
      expect(listing).not.toContain(".config/gcloud/data");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  // The verify step reads the member list back out of the packed archive, so
  // listing has to feed tar the archive on stdin.  Without it tar waits for a
  // stream that never arrives and the whole credential sync hangs.
  it("lists the members the archive packed, reading the archive from stdin", async () => {
    const home = mkdtempSync(join(tmpdir(), "bf-cred-members-"));
    try {
      mkdirSync(join(home, ".ssh"), { recursive: true });
      writeFileSync(join(home, ".ssh", "config"), "Host *\n");
      mkdirSync(join(home, ".config", "gcloud", "logs", "2026.10.07"), { recursive: true });
      writeFileSync(join(home, ".config", "gcloud", "credentials.db"), "credential-bytes");
      writeFileSync(join(home, ".config", "gcloud", "logs", "2026.10.07", "run.log"), "debug-chatter");

      const plan = planCredentialSync({ homeDir: home });
      const archive = await packageCredentialArchive(home, plan);
      const members = await listArchiveRelPaths(archive!);

      // Files, not just the directories that contain them, so a destination
      // that exists while its credential did not land is still detectable.
      expect(members).toContain(".ssh/config");
      expect(members).toContain(".config/gcloud/credentials.db");
      expect(members.some((entry) => entry.includes("gcloud/logs"))).toBe(false);
      // Directory members never carry a trailing slash into the probe.
      expect(members.every((entry) => !entry.endsWith("/"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  // ~/.deno/bin/deno (79MB) and ~/.turso's two binaries (54MB) are installed
  // tools, not credentials, and the guest installs both CLIs itself.  Shipping
  // them put a 134MB archive on the wire for every single sync.
  it("excludes installed tool binaries that live under a credential root", async () => {
    const home = mkdtempSync(join(tmpdir(), "bf-cred-binaries-"));
    try {
      mkdirSync(join(home, ".deno", "bin"), { recursive: true });
      mkdirSync(join(home, ".turso"), { recursive: true });
      writeFileSync(join(home, ".deno", "bin", "deno"), "x".repeat(4096));
      writeFileSync(join(home, ".turso", "sqld"), "x".repeat(4096));
      writeFileSync(join(home, ".turso", "turso"), "x".repeat(4096));
      writeFileSync(join(home, ".deno", "env"), "DENO_DIR=/tmp/deno\n");

      const plan = planCredentialSync({ homeDir: home });
      const archive = await packageCredentialArchive(home, plan);
      const members = await listArchiveRelPaths(archive!);

      expect(members).toContain(".deno/env");
      expect(members).not.toContain(".deno/bin/deno");
      expect(members).not.toContain(".turso/sqld");
      expect(members).not.toContain(".turso/turso");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

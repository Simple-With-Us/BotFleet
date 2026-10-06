import { describe, expect, it } from "vitest";

import { loadVmCliManifest, vmCliInstallableTools, vmCliToolsForEnvironment } from "./vm-cli-manifest.ts";
import {
  renderDockerfileCliInstallRun,
  renderDockerfileVerifyArtifacts,
  renderLinuxInstallScript,
  renderVerifyScript,
  vmCliManifestDigest,
} from "./vm-cli-install.ts";
import { managedImageDockerfile } from "./container-computer.ts";

describe("vm CLI manifest install", () => {
  it("lists every Both-target tool from the fleet inventory", () => {
    const names = new Set(loadVmCliManifest().tools.map((tool) => tool.name));
    for (const required of [
      "aws",
      "cargo",
      "cf",
      "docker",
      "gcloud",
      "gh",
      "gpg",
      "kodus",
      "kubectl",
      "node",
      "npm",
      "pnpm",
      "psql",
      "rsync",
      "turso",
      "vercel",
      "python3",
      "jq",
      "fzf",
      "fd",
      "vim",
      "tmux",
      "sqlite3",
      "rustc",
      "java",
      "ruby",
      "gem",
      "perl",
      "deno",
      "clang",
      "gcc",
      "make",
      "ffmpeg",
      "curl",
      "zip",
      "unzip",
      "ssh",
      "scp",
      "sftp",
      "openssl",
    ]) {
      expect(names.has(required)).toBe(true);
    }
  });

  it("keeps clipboard shims local-vm only", () => {
    const cloud = new Set(vmCliToolsForEnvironment("cloud").map((tool) => tool.name));
    const local = new Set(vmCliToolsForEnvironment("local-vm").map((tool) => tool.name));
    expect(cloud.has("pbcopy")).toBe(false);
    expect(local.has("pbcopy")).toBe(true);
    expect(local.has("pbpaste")).toBe(true);
  });

  it("embeds the shared install layer in the managed desktop Dockerfile", () => {
    const dockerfile = managedImageDockerfile();
    expect(dockerfile).toContain("BOTFLEET_VM_CLI_INSTALL");
    expect(dockerfile).toContain("botfleet-vm-cli-verify");
    expect(dockerfile).toContain(renderDockerfileCliInstallRun("local-vm").trim());
    expect(vmCliManifestDigest()).toHaveLength(64);
  });

  // Regression, 2026-10-06: the verify artifact stripped its shebang before
  // writing it to /usr/local/bin/botfleet-vm-cli-verify and then executed that
  // file directly.  With no shebang the kernel used /bin/sh, which is dash on
  // Debian, and `set -euo pipefail` died with "Illegal option -o pipefail".
  // The image build failed at the last step even though every CLI had already
  // installed.  Nothing caught it because CI runs these unit tests and never
  // builds the image, so the assertion has to be here.
  it("gives the verify script a shebang, because the image executes it directly", () => {
    const artifacts = renderDockerfileVerifyArtifacts("local-vm");
    const written = artifacts.match(
      /cat > \/usr\/local\/bin\/botfleet-vm-cli-verify\n([\s\S]*?)\nBOTFLEET_VM_CLI_VERIFY_BIN/,
    );
    expect(written).not.toBeNull();
    const body = (written as RegExpMatchArray)[1];
    expect(body.split("\n")[0]).toBe("#!/usr/bin/env bash");
    // dash rejects this outright, so it is the specific thing the shebang buys.
    expect(body).toContain("set -euo pipefail");
  });

  it("runs the verify script rather than piping it to an interpreter", () => {
    const artifacts = renderDockerfileVerifyArtifacts("local-vm");
    expect(artifacts).toContain(
      "RUN chmod 0755 /usr/local/bin/botfleet-vm-cli-verify && /usr/local/bin/botfleet-vm-cli-verify",
    );
  });

  it("renders verify checks for every installable tool", () => {
    const script = renderVerifyScript("cloud");
    for (const tool of vmCliInstallableTools("cloud")) {
      expect(script).toContain(tool.name);
    }
    expect(renderLinuxInstallScript("local-vm")).toContain("botfleet_install_apt");
  });
});

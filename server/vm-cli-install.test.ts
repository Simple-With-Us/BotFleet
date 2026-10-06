import { describe, expect, it } from "vitest";

import { loadVmCliManifest, vmCliInstallableTools, vmCliToolsForEnvironment } from "./vm-cli-manifest.ts";
import {
  renderDockerfileCliInstallRun,
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

  it("renders verify checks for every installable tool", () => {
    const script = renderVerifyScript("cloud");
    for (const tool of vmCliInstallableTools("cloud")) {
      expect(script).toContain(tool.name);
    }
    expect(renderLinuxInstallScript("local-vm")).toContain("botfleet_install_apt");
  });
});

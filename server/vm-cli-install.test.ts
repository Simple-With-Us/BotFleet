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

  // Regression, 2026-10-06: the image build reported
  //   missing VM CLIs: scp sftp cargo rustc
  // rustup's shims resolve the toolchain through RUSTUP_HOME, and the recipe
  // exported it for the length of the recipe only.  The verify layer is a
  // separate RUN, so it — and every shell in the container — saw no RUSTUP_HOME
  // and got "rustup could not choose a version of cargo to run".  Reproduced
  // in the base image: `cargo --version` succeeds with RUSTUP_HOME set and
  // fails without it.
  it("bakes RUSTUP_HOME into the image, so the shims outlive the recipe", () => {
    const run = renderDockerfileCliInstallRun("local-vm");
    expect(run).toContain("ENV RUSTUP_HOME=/usr/local/rustup");
    // ENV only reaches later layers when it is its own instruction.
    expect(run).toMatch(/BOTFLEET_VM_CLI_INSTALL\nENV RUSTUP_HOME=/);
  });

  it("does NOT bake CARGO_HOME, which would hide the synced cargo credentials", () => {
    // Kody review on #911, and correct: cargo resolves config.toml and
    // credentials.toml *under* CARGO_HOME rather than extending $HOME/.cargo,
    // and the manifest syncs cargo's credentialPaths to /home/cua/.cargo.
    // Overriding it points the lookup at a root-owned directory, so
    // private-registry tokens are ignored and `cargo login` fails as cua.
    const run = renderDockerfileCliInstallRun("local-vm");
    expect(run).not.toContain("ENV CARGO_HOME=");
  });

  // Regression, 2026-10-06: the v6 build reported
  //   missing VM CLIs: scp sftp cargo rustc
  // scp and sftp were installed the whole time.  openssh-client ships both
  // binaries; the manifest verified them with `-V`, which neither supports, so
  // the check ran a usage error that exits 1 and read as "missing".  ssh uses
  // the same `-V` and genuinely supports it, which is why ssh was never
  // reported — the only clue that the flag, not the package, was at fault.
  // Verified on the pinned base image: ssh -V exits 0, scp -V and sftp -V exit
  // 1, and `command -v` succeeds for all three.
  it("verifies scp and sftp with a presence check, not a flag they lack", () => {
    const script = renderVerifyScript("local-vm");
    for (const name of ["scp", "sftp"]) {
      const tool = loadVmCliManifest().tools.find((t) => t.name === name);
      expect(tool?.verify?.command, `${name} must not be probed with -V`).toBe("command");
      expect(tool?.verify?.args).toEqual(["-v", name]);
      // Args are shell-quoted by the renderer, so match the real output.
      expect(script).toContain(`command '-v' '${name}'`);
      expect(script).not.toContain(`${name} -V`);
    }
    // ssh genuinely supports -V, so it must keep using it.
    expect(script).toContain("ssh '-V'");
  });

  it("keeps scp and sftp on openssh-client, which ships both binaries", () => {
    // There is no binary package named `scp` in bookworm: `apt-cache show scp`
    // finds nothing, so naming one aborts the whole install RUN under
    // `set -euo pipefail`.  Kody review on #911 caught that in the first draft.
    for (const name of ["scp", "sftp"]) {
      const tool = loadVmCliManifest().tools.find((t) => t.name === name);
      expect(tool?.apt).toEqual(["openssh-client"]);
    }
  });

  it("renders verify checks for every installable tool", () => {
    const script = renderVerifyScript("cloud");
    for (const tool of vmCliInstallableTools("cloud")) {
      expect(script).toContain(tool.name);
    }
    expect(renderLinuxInstallScript("local-vm")).toContain("botfleet_install_apt");
  });
});

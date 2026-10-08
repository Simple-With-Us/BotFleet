import { describe, expect, it } from "vitest";

import { loadVmCliManifest, vmCliInstallableTools, vmCliToolsForEnvironment } from "./vm-cli-manifest.ts";
import {
  HOMEBREW_PREFIX,
  HOMEBREW_VERSION,
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

  // The Mac-parity layer: every name here is image content that exists only on
  // the Local VM.  Cloud agents and Box desktops share this manifest, so a
  // `both` target would re-run these installs on machines that never asked.
  const MAC_PARITY_TOOLS = [
    "brew", "zsh", "open",
    "rg", "shellcheck", "tesseract", "pdftotext", "pdfimages", "protoc", "gdu", "mosh", "git-filter-repo",
    "cloudflared", "actionlint", "gitleaks", "mise", "uv", "uvx", "yq",
    "wrangler", "pm2", "sentry-cli",
    "git-cli", "tree", "wget", "htop", "lsof", "dig", "nc", "less", "file", "patch", "bc", "xz", "zstd",
    "7z", "convert", "strace", "ping", "ps", "bat",
  ];

  it("carries the Mac-parity tools in the Local VM and nowhere else", () => {
    const local = new Set(vmCliToolsForEnvironment("local-vm").map((tool) => tool.name));
    const cloud = new Set(vmCliToolsForEnvironment("cloud").map((tool) => tool.name));
    for (const name of MAC_PARITY_TOOLS) {
      expect(local.has(name), `${name} must be in the Local VM`).toBe(true);
      expect(cloud.has(name), `${name} must not leak into the cloud install`).toBe(false);
    }
  });

  it("verifies every Mac-parity tool in the build", () => {
    const script = renderVerifyScript("local-vm");
    for (const name of MAC_PARITY_TOOLS) {
      expect(script, `${name} needs a verify check`).toContain(`missing="$missing ${name}"`);
    }
  });

  describe("Homebrew", () => {
    const install = renderLinuxInstallScript("local-vm");

    it("is a pinned archive whose sha256 is checked before it is unpacked", () => {
      expect(install).toContain(`https://github.com/Homebrew/brew/archive/refs/tags/${HOMEBREW_VERSION}.tar.gz`);
      const check = install.indexOf('echo "2823a11d81e7582d7ef9c44a85187462db92184133f9c9927f853b5c38d9538e  $brew_tgz" | sha256sum -c -');
      const unpack = install.indexOf('tar -xzf "$brew_tgz"');
      expect(check).toBeGreaterThan(-1);
      expect(unpack).toBeGreaterThan(check);
      expect(loadVmCliManifest().tools.find((tool) => tool.name === "brew")?.version).toBe(HOMEBREW_VERSION);
    });

    it("installs as cua, because brew refuses root, and installs no formulae", () => {
      expect(install).toContain("chown -R cua:cua /home/linuxbrew");
      expect(install).toContain('runuser -u cua -- env HOME=/home/cua "$brew_prefix/bin/brew" vendor-install ruby');
      // Comments may say "brew install"; no command line may run it.
      const commands = install.split("\n").filter((line) => !line.trim().startsWith("#"));
      expect(commands.filter((line) => /\bbrew" install\b|\bbrew install\b/.test(line))).toEqual([]);
    });

    it("goes on PATH after /usr/local/bin, never before, at every layer", () => {
      const run = renderDockerfileCliInstallRun("local-vm");
      // Docker ENV is the layer that reaches `docker exec -u cua` with no shell init.
      expect(run).toContain("ENV HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1");
      expect(run).toContain(`ENV PATH=$PATH:${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin`);
      expect(run).not.toMatch(/ENV PATH=[^\n]*linuxbrew[^\n]*:\$PATH/);
      // The profile.d snippet appends too, and `brew shellenv` (which prepends) is never used.
      expect(install).toContain(`PATH="$PATH:${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin"`);
      expect(install).not.toMatch(/PATH="[^"]*linuxbrew[^"]*:\$PATH"/);
      expect(install).not.toMatch(/eval[^\n]*brew shellenv/);
    });

    it("exports the PATH before the verify layer runs, so verify sees brew", () => {
      const dockerfile = managedImageDockerfile();
      const env = dockerfile.indexOf(`ENV PATH=$PATH:${HOMEBREW_PREFIX}/bin`);
      const verify = dockerfile.indexOf("RUN chmod 0755 /usr/local/bin/botfleet-vm-cli-verify");
      expect(env).toBeGreaterThan(-1);
      expect(verify).toBeGreaterThan(env);
    });

    it("wires interactive bash to the same snippet", () => {
      expect(install).toContain("cat >> /home/cua/.bashrc");
      expect(install).toContain("/etc/profile.d/botfleet-*.sh");
    });

    it("verifies brew as cua when run as root, and as the caller otherwise", () => {
      // brew refuses root, and `runuser` fails for anyone but root, so the
      // check has to branch.  Image builds run it as root; a bot runs it as cua.
      const script = renderVerifyScript("local-vm");
      expect(script).toContain("runuser -u cua -- env HOME=/home/cua brew --version");
      expect(script).toContain('"$(id -u)" -eq 0');
    });
  });

  describe("zsh", () => {
    const install = renderLinuxInstallScript("local-vm");

    it("becomes the cua login shell and ships dotfiles cua owns", () => {
      expect(install).toContain('usermod -s "$zsh_bin" cua');
      // The ownership sweep at the end of the recipe covers both dotfiles.
      expect(install).toContain("find /home/cua -xdev -user root -exec chown -h cua:cua {} +");
    });

    it("gives every zsh, not just login shells, the same PATH as bash", () => {
      // Debian's zsh never reads /etc/profile.d, so .zshenv has to.  Every zsh
      // reads .zshenv, which is what a bot's `zsh -c` relies on.
      const zshenv = install.match(/cat > \/home\/cua\/\.zshenv <<'EOF'\n([\s\S]*?)\nEOF/);
      expect(zshenv?.[1]).toContain("/etc/profile.d/botfleet-*.sh");
      expect(zshenv?.[1]).toContain("typeset -U path");
    });

    it("sets up history and completion so interactive zsh starts silently", () => {
      const zshrc = install.match(/cat > \/home\/cua\/\.zshrc <<'EOF'\n([\s\S]*?)\nEOF/);
      expect(zshrc?.[1]).toContain("HISTFILE=");
      expect(zshrc?.[1]).toContain("compinit");
    });

    it("verifies the login shell, not just that zsh exists", () => {
      const script = renderVerifyScript("local-vm");
      expect(script).toContain("getent passwd cua");
      expect(script).toContain("zsh --version");
    });
  });

  describe("open and bat shims", () => {
    it("shims open onto xdg-open and verifies the shim, not whatever else is named open", () => {
      // Debian's /usr/bin/open is the kbd openvt alias, so `command -v open`
      // would pass even if this shim never landed.
      const install = renderLinuxInstallScript("local-vm");
      expect(install).toMatch(/cat > \/usr\/local\/bin\/open <<'EOF'\n#!\/bin\/sh\nexec xdg-open "\$@"\nEOF/);
      expect(renderVerifyScript("local-vm")).toContain("test '-x' '/usr/local/bin/open'");
    });

    it("links Debian's batcat as bat, the way fd is linked", () => {
      expect(renderLinuxInstallScript("local-vm")).toContain(
        'ln -sf "$(command -v batcat || true)" /usr/local/bin/bat || true',
      );
    });
  });

  // Found by building the v8 image and listing /home/cua: the verify step runs
  // as root with HOME=/home/cua, and pm2, wrangler and mise each write state
  // under $HOME on their first run, even for --version.  The result was a
  // root-owned ~/.pm2, ~/.config/.wrangler and ~/.cache/mise, and the first
  // real use by cua died with EACCES.
  describe("ownership of the desktop user's home", () => {
    it("hands root-created state in cua's home back to cua in the verify layer itself", () => {
      // The verify layer runs as root with HOME=/home/cua.  Only the entries root
      // created are chowned, in the same RUN, so the layer does not duplicate the home.
      const artifacts = renderDockerfileVerifyArtifacts("local-vm");
      expect(artifacts).toContain(
        "/usr/local/bin/botfleet-vm-cli-verify && find /home/cua -xdev -user root -exec chown -h cua:cua {} +",
      );
    });

    it("keeps the real HOME while verifying, because pnpm finds its corepack cache through it", () => {
      const script = renderVerifyScript("local-vm");
      expect(script).not.toContain("mktemp");
      expect(script).not.toContain("export HOME=");
    });

    it("hands the home back to cua after every recipe has run as root", () => {
      const install = renderLinuxInstallScript("local-vm");
      const zsh = install.slice(install.indexOf("botfleet_install_zsh_shell() {"));
      expect(zsh).toContain("find /home/cua -xdev -user root -exec chown -h cua:cua {} +\n}");
      // It must be the last recipe: anything that ran after it could re-create root-owned state.
      const calls = install.slice(install.indexOf("botfleet_install_apt\n"));
      const recipeCalls = calls.split("\n").filter((line) => line.startsWith("  botfleet_install_"));
      expect(recipeCalls.at(-1)).toBe("  botfleet_install_zsh_shell");
    });

    it("drops the npm download cache that installing as root leaves in cua's home", () => {
      const install = renderLinuxInstallScript("local-vm");
      expect(install).toContain("npm cache clean --force");
      expect(install).toContain('rm -rf "$(npm config get cache)"');
    });
  });

  describe("pinned binaries", () => {
    const install = renderLinuxInstallScript("local-vm");
    const pinned = loadVmCliManifest().tools.filter((tool) => tool.recipe === "pinned_binary");

    it("pins every download per architecture with a sha256", () => {
      expect(pinned.map((tool) => tool.name).sort()).toEqual(
        ["actionlint", "cloudflared", "gitleaks", "mise", "uv", "uvx", "yq"].sort(),
      );
      for (const tool of pinned) {
        expect(tool.download, `${tool.name} needs a download`).toBeDefined();
        for (const arch of ["x86_64", "aarch64"] as const) {
          const asset = tool.download!.assets[arch];
          expect(install, `${tool.name} ${arch}`).toContain(asset.url);
          expect(install, `${tool.name} ${arch}`).toContain(asset.sha256);
        }
      }
    });

    it("checks the sha256 before unpacking or installing anything", () => {
      const fn = install.slice(install.indexOf("botfleet_pin_fetch() {"));
      expect(fn.indexOf("sha256sum -c -")).toBeGreaterThan(-1);
      expect(fn.indexOf("sha256sum -c -")).toBeLessThan(fn.indexOf("tar -xf"));
      expect(fn.indexOf("sha256sum -c -")).toBeLessThan(fn.indexOf("install -m 0755"));
    });

    it("downloads a shared archive once: uv and uvx are one tarball", () => {
      const uvTarball = loadVmCliManifest().tools.find((tool) => tool.name === "uv")!.download!.assets.x86_64.url;
      expect(install.split(uvTarball)).toHaveLength(2);
      expect(install).toContain("uv-x86_64-unknown-linux-gnu/uvx=uvx");
    });

    it("covers both CPU architectures and refuses any other", () => {
      expect(install).toContain("x86_64) botfleet_pin_fetch 'uv'");
      expect(install).toContain("aarch64|arm64) botfleet_pin_fetch 'uv'");
      expect(install).toContain('unsupported architecture for uv: $(uname -m)');
    });
  });

  describe("npm globals", () => {
    it("pins wrangler, pm2 and sentry-cli to exact versions", () => {
      const install = renderLinuxInstallScript("local-vm");
      for (const [name, pkg] of [["wrangler", "wrangler"], ["pm2", "pm2"], ["sentry-cli", "@sentry/cli"]] as const) {
        const tool = loadVmCliManifest().tools.find((entry) => entry.name === name)!;
        expect(tool.version, `${name} must not float on latest`).toMatch(/^\d+\.\d+\.\d+$/);
        expect(install).toContain(`npm install -g '${pkg}@${tool.version}'`);
      }
    });
  });

  describe("apt tools that Debian names differently or leaves out", () => {
    it("installs git explicitly, because the base image has none and brew needs it", () => {
      const tools = loadVmCliManifest().tools;
      expect(tools.find((tool) => tool.name === "git-cli")?.apt).toEqual(["git"]);
      expect(tools.find((tool) => tool.name === "brew")?.apt).toEqual(expect.arrayContaining(["git", "file", "procps"]));
    });

    it("verifies git-filter-repo through git, which is how it is actually invoked", () => {
      const tool = loadVmCliManifest().tools.find((entry) => entry.name === "git-filter-repo");
      expect(tool?.verify).toEqual({ command: "git", args: ["filter-repo", "--version"] });
    });
  });

  it("renders verify checks for every installable tool", () => {
    const script = renderVerifyScript("cloud");
    for (const tool of vmCliInstallableTools("cloud")) {
      expect(script).toContain(tool.name);
    }
    expect(renderLinuxInstallScript("local-vm")).toContain("botfleet_install_apt");
  });
});

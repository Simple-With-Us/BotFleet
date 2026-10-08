import { createHash } from "node:crypto";

import {
  collectAptPackages,
  loadVmCliManifest,
  vmCliInstallableTools,
  vmCliToolsForEnvironment,
  type VmCliDownload,
  type VmCliEnvironment,
  type VmCliTool,
} from "./vm-cli-manifest.ts";

const NODE_VERSION = "24.11.0";
const PNPM_VERSION = "10.33.0";
const GH_VERSION = "2.63.2";
const KUBECTL_VERSION = "1.32.0";
const DOCKER_CLI_VERSION = "27.4.1";
const DENO_VERSION = "2.2.0";
/** Homebrew/brew release tag and the sha256 of its GitHub source archive.
 * Pinned the same way the cua-driver wheel is: a mismatch fails the build
 * rather than installing whatever the tag now points at.  `manifest.json`
 * carries the same version string and a test keeps the two equal. */
export const HOMEBREW_VERSION = "7.0.8";
const HOMEBREW_SHA256 = "2823a11d81e7582d7ef9c44a85187462db92184133f9c9927f853b5c38d9538e";
export const HOMEBREW_PREFIX = "/home/linuxbrew/.linuxbrew";
/** The account every desktop session runs as.  Homebrew refuses root, the
 * login shell belongs to it, and its dotfiles are the ones a bot's shell reads. */
const DESKTOP_USER = "cua";
const DESKTOP_HOME = "/home/cua";
const RUSTUP_HOME_KEY = "RUSTUP_HOME";
const RUSTUP_HOME_DIR = "/usr/local/rustup";
/** Used only while installing.  It is intentionally not baked into the image —
 * see rustupImageEnv for why that would break the synced cargo credentials. */
const CARGO_HOME_DIR = "/usr/local/cargo";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function recipeBlocks(environment: VmCliEnvironment): string[] {
  const tools = vmCliToolsForEnvironment(environment);
  const recipes = new Set(tools.map((tool) => tool.recipe).filter(Boolean));
  const blocks: string[] = [];

  if (recipes.has("node")) {
    blocks.push(`
botfleet_install_node() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64) node_arch="linux-x64" ;;
    aarch64|arm64) node_arch="linux-arm64" ;;
    *) echo "unsupported architecture for node: $arch" >&2; return 1 ;;
  esac
  node_tgz="/tmp/node-v${NODE_VERSION}-$node_arch.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-$node_arch.tar.xz" -o "$node_tgz"
  tar -xJf "$node_tgz" -C /usr/local --strip-components=1
  rm -f "$node_tgz"
  node --version
  npm --version
}
`);
  }

  if (recipes.has("pnpm")) {
    blocks.push(`
botfleet_install_pnpm() {
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@${PNPM_VERSION} --activate
  pnpm --version
}
`);
  }

  if (recipes.has("npm_global")) {
    const packages = tools
      .filter((tool) => tool.recipe === "npm_global" && tool.npmPackage)
      .map((tool) => ({ name: tool.name, pkg: tool.npmPackage as string, version: tool.version }));
    const installLines = packages.map((entry) => {
      const spec = entry.version === "latest" ? entry.pkg : `${entry.pkg}@${entry.version}`;
      return `  npm install -g ${shellQuote(spec)}`;
    });
    blocks.push(`
botfleet_install_npm_globals() {
  export npm_config_update_notifier=false
  export npm_config_fund=false
${installLines.join("\n")}
  # Installing as root with HOME=/home/cua left a root-owned ~/.npm of several
  # hundred MB in the desktop user's home.  It is only a download cache.
  npm cache clean --force >/dev/null 2>&1 || true
}
`);
  }

  if (recipes.has("awscli")) {
    blocks.push(`
botfleet_install_awscli() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64) aws_arch="x86_64" ;;
    aarch64|arm64) aws_arch="aarch64" ;;
    *) echo "unsupported architecture for awscli: $arch" >&2; return 1 ;;
  esac
  aws_zip="/tmp/awscliv2.zip"
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$aws_arch.zip" -o "$aws_zip"
  unzip -q "$aws_zip" -d /tmp/awscliv2
  /tmp/awscliv2/aws/install --update
  rm -rf /tmp/awscliv2 "$aws_zip"
  aws --version
}
`);
  }

  if (recipes.has("gcloud")) {
    blocks.push(`
botfleet_install_gcloud() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64) gcloud_arch="x86_64" ;;
    aarch64|arm64) gcloud_arch="arm" ;;
    *) echo "unsupported architecture for gcloud: $arch" >&2; return 1 ;;
  esac
  gcloud_tgz="/tmp/google-cloud-cli-linux-$gcloud_arch.tar.gz"
  curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-$gcloud_arch.tar.gz" -o "$gcloud_tgz"
  rm -rf /opt/google-cloud-sdk
  tar -xzf "$gcloud_tgz" -C /opt
  /opt/google-cloud-sdk/install.sh --quiet --path-update true --command-completion false --usage-reporting false
  ln -sf /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud
  ln -sf /opt/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil
  ln -sf /opt/google-cloud-sdk/bin/bq /usr/local/bin/bq
  rm -f "$gcloud_tgz"
  gcloud --version | head -1
}
`);
  }

  if (recipes.has("gh")) {
    blocks.push(`
botfleet_install_gh() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64) gh_arch="amd64" ;;
    aarch64|arm64) gh_arch="arm64" ;;
    *) echo "unsupported architecture for gh: $arch" >&2; return 1 ;;
  esac
  gh_tgz="/tmp/gh_${GH_VERSION}_linux_$gh_arch.tar.gz"
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_$gh_arch.tar.gz" -o "$gh_tgz"
  tar -xzf "$gh_tgz" -C /tmp
  install -m 0755 "/tmp/gh_${GH_VERSION}_linux_$gh_arch/bin/gh" /usr/local/bin/gh
  rm -rf "/tmp/gh_${GH_VERSION}_linux_$gh_arch" "$gh_tgz"
  gh --version
}
`);
  }

  if (recipes.has("kubectl")) {
    blocks.push(`
botfleet_install_kubectl() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64) kubectl_arch="amd64" ;;
    aarch64|arm64) kubectl_arch="arm64" ;;
    *) echo "unsupported architecture for kubectl: $arch" >&2; return 1 ;;
  esac
  kubectl_bin="/tmp/kubectl"
  curl -fsSL "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/$kubectl_arch/kubectl" -o "$kubectl_bin"
  install -m 0755 "$kubectl_bin" /usr/local/bin/kubectl
  rm -f "$kubectl_bin"
  kubectl version --client=true
}
`);
  }

  if (recipes.has("docker_cli")) {
    blocks.push(`
botfleet_install_docker_cli() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64) docker_arch="x86_64" ;;
    aarch64|arm64) docker_arch="aarch64" ;;
    *) echo "unsupported architecture for docker cli: $arch" >&2; return 1 ;;
  esac
  docker_tgz="/tmp/docker-${DOCKER_CLI_VERSION}.tgz"
  curl -fsSL "https://download.docker.com/linux/static/stable/$docker_arch/docker-${DOCKER_CLI_VERSION}.tgz" -o "$docker_tgz"
  tar -xzf "$docker_tgz" -C /tmp
  install -m 0755 "/tmp/docker/docker" /usr/local/bin/docker
  rm -rf /tmp/docker "$docker_tgz"
  docker --version
}
`);
  }

  if (recipes.has("turso")) {
    blocks.push(`
botfleet_install_turso() {
  curl -fsSL https://get.tur.so/install.sh | bash
  install -m 0755 "$HOME/.turso/turso" /usr/local/bin/turso
  turso --version
}
`);
  }

  if (recipes.has("deno")) {
    blocks.push(`
botfleet_install_deno() {
  export DENO_INSTALL=/usr/local
  curl -fsSL https://deno.land/install.sh | sh -s "v${DENO_VERSION}"
  deno --version
}
`);
  }

  if (recipes.has("rustup")) {
    blocks.push(`
botfleet_install_rustup() {
  export RUSTUP_HOME=${RUSTUP_HOME_DIR}
  export CARGO_HOME=${CARGO_HOME_DIR}  # install-time only; see rustupImageEnv
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
  ln -sf /usr/local/cargo/bin/cargo /usr/local/bin/cargo
  ln -sf /usr/local/cargo/bin/rustc /usr/local/bin/rustc
  cargo --version
  rustc --version
}
`);
  }

  if (recipes.has("pbcopy_shim")) {
    blocks.push(`
botfleet_install_pbcopy_shims() {
  cat > /usr/local/bin/pbcopy <<'EOF'
#!/bin/sh
exec xclip -selection clipboard
EOF
  cat > /usr/local/bin/pbpaste <<'EOF'
#!/bin/sh
exec xclip -selection clipboard -o
EOF
  chmod 0755 /usr/local/bin/pbcopy /usr/local/bin/pbpaste
}
`);
  }

  if (recipes.has("pinned_binary")) {
    blocks.push(renderPinnedBinaryBlock(tools));
  }

  if (recipes.has("homebrew")) {
    blocks.push(renderHomebrewBlock());
  }

  if (recipes.has("zsh_shell")) {
    blocks.push(renderZshShellBlock());
  }

  if (recipes.has("open_shim")) {
    blocks.push(`
botfleet_install_open_shim() {
  # /usr/bin/open is kbd's openvt alias on Debian, which is not what a bot
  # means by \`open\`.  /usr/local/bin comes first on PATH, so this wins.
  cat > /usr/local/bin/open <<'EOF'
#!/bin/sh
exec xdg-open "$@"
EOF
  chmod 0755 /usr/local/bin/open
}
`);
  }

  return blocks;
}

/** Tools that ship an identical download (uv and uvx are one archive) install
 * once.  Keyed by the whole download so a tool can never silently reuse
 * another's artifact just because the names are close. */
function pinnedBinaryDownloads(tools: VmCliTool[]): Array<{ name: string; download: VmCliDownload }> {
  const seen = new Set<string>();
  const downloads: Array<{ name: string; download: VmCliDownload }> = [];
  for (const tool of tools) {
    if (tool.recipe !== "pinned_binary") continue;
    if (!tool.download) {
      throw new Error(`manifest tool ${tool.name} uses recipe pinned_binary but has no download`);
    }
    const key = JSON.stringify(tool.download);
    if (seen.has(key)) continue;
    seen.add(key);
    downloads.push({ name: tool.name, download: tool.download });
  }
  return downloads;
}

function renderPinnedBinaryBlock(tools: VmCliTool[]): string {
  const calls = pinnedBinaryDownloads(tools).map(({ name, download }) => {
    const arms = (["x86_64", "aarch64"] as const).map((arch) => {
      const asset = download.assets[arch];
      // Archive files travel as `path=name`; a raw download is just `name`.
      const files = asset.files
        .map((file) => (file.path === undefined ? file.as : `${file.path}=${file.as}`))
        .map(shellQuote)
        .join(" ");
      const label = arch === "x86_64" ? "x86_64" : "aarch64|arm64";
      return `    ${label}) botfleet_pin_fetch ${shellQuote(name)} ${shellQuote(download.format)} ${shellQuote(asset.url)} ${shellQuote(asset.sha256)} ${files} ;;`;
    });
    return `  case "$(uname -m)" in
${arms.join("\n")}
    *) echo "unsupported architecture for ${name}: $(uname -m)" >&2; return 1 ;;
  esac`;
  });
  return `
# botfleet_pin_fetch NAME FORMAT URL SHA256 FILE...
# FILE is \`path=name\` for an archive and \`name\` for a raw binary.  The sha256
# is checked BEFORE anything is unpacked or installed.
botfleet_pin_fetch() {
  pin_name="$1"; pin_format="$2"; pin_url="$3"; pin_sha="$4"
  shift 4
  pin_work="$(mktemp -d)"
  curl -fsSL "$pin_url" -o "$pin_work/asset"
  echo "$pin_sha  $pin_work/asset" | sha256sum -c -
  case "$pin_format" in
    raw)
      install -m 0755 "$pin_work/asset" "/usr/local/bin/$1"
      ;;
    tar.gz|tar.xz)
      mkdir "$pin_work/extract"
      tar -xf "$pin_work/asset" -C "$pin_work/extract"
      for pin_file in "$@"; do
        install -m 0755 "$pin_work/extract/\${pin_file%%=*}" "/usr/local/bin/\${pin_file#*=}"
      done
      ;;
    *)
      echo "unsupported pinned format for $pin_name: $pin_format" >&2
      rm -rf "$pin_work"
      return 1
      ;;
  esac
  rm -rf "$pin_work"
}

botfleet_install_pinned_binaries() {
${calls.join("\n")}
}
`;
}

/** Homebrew (Linuxbrew) from a pinned release archive, installed as the
 * desktop user because brew refuses root.  Brew only; no formulae.
 *
 * It goes on PATH AFTER /usr/local/bin and the system directories, never
 * before.  `brew shellenv` prepends, which would let a brew-installed node
 * shadow the pinned node 24, so the PATH is written out by hand here and in
 * homebrewImageEnv.  The archive has no .git.  An explicit `brew update` still
 * works because git is installed: it fetches Homebrew's history and moves off
 * the pinned release (checked on arm64).  HOMEBREW_NO_AUTO_UPDATE only stops
 * brew doing that implicitly, so the image stays on the pin until a bot asks.
 * Rebuilding the image resets it. */
function renderHomebrewBlock(): string {
  const url = `https://github.com/Homebrew/brew/archive/refs/tags/${HOMEBREW_VERSION}.tar.gz`;
  return `
botfleet_install_homebrew() {
  id -u ${DESKTOP_USER} >/dev/null 2>&1 || { echo "homebrew needs the ${DESKTOP_USER} user, which this host does not have" >&2; return 1; }
  brew_prefix=${HOMEBREW_PREFIX}
  brew_tgz="/tmp/homebrew-${HOMEBREW_VERSION}.tar.gz"
  curl -fsSL "${url}" -o "$brew_tgz"
  echo "${HOMEBREW_SHA256}  $brew_tgz" | sha256sum -c -
  rm -rf "$brew_prefix"
  install -d -m 0755 "$brew_prefix/Homebrew" "$brew_prefix/bin"
  tar -xzf "$brew_tgz" -C "$brew_prefix/Homebrew" --strip-components=1
  rm -f "$brew_tgz"
  ln -sf ../Homebrew/bin/brew "$brew_prefix/bin/brew"
  for brew_dir in Cellar Caskroom etc include lib opt sbin share var/homebrew/linked; do
    install -d -m 0755 "$brew_prefix/$brew_dir"
  done
  chown -R ${DESKTOP_USER}:${DESKTOP_USER} /home/linuxbrew
  cat > /etc/profile.d/botfleet-brew.sh <<'EOF'
# Managed by BotFleet.  Homebrew goes AFTER the system and /usr/local
# directories so a formula can never shadow a pinned tool.  Do not replace this
# with \`brew shellenv\`, which prepends.
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_ANALYTICS=1
case ":$PATH:" in
  *":${HOMEBREW_PREFIX}/bin:"*) ;;
  *) PATH="$PATH:${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin" ;;
esac
export PATH
EOF
  chmod 0644 /etc/profile.d/botfleet-brew.sh
  # Interactive bash.  Non-interactive shells get PATH from the image ENV.
  if ! grep -q 'botfleet-\\*.sh' ${DESKTOP_HOME}/.bashrc 2>/dev/null; then
    cat >> ${DESKTOP_HOME}/.bashrc <<'EOF'

# Managed by BotFleet: tool PATH snippets.
for botfleet_profile in /etc/profile.d/botfleet-*.sh; do
  [ -r "$botfleet_profile" ] && . "$botfleet_profile"
done
unset botfleet_profile
EOF
  fi
  # Fetch brew's portable Ruby now, so the first \`brew install\` does not have
  # to and still works if ghcr.io is unreachable from the running container.
  runuser -u ${DESKTOP_USER} -- env HOME=${DESKTOP_HOME} "$brew_prefix/bin/brew" vendor-install ruby
  runuser -u ${DESKTOP_USER} -- env HOME=${DESKTOP_HOME} "$brew_prefix/bin/brew" --version
}
`;
}

/** Give the desktop user the same shell a Mac gives its owner: zsh as the login
 * shell, with a PATH that matches bash and the usual history and completion.
 * Debian's zsh never reads /etc/profile.d, so .zshenv does it, and every zsh
 * reads .zshenv, which is what makes a bot's `zsh -c` see the same tools. */
function renderZshShellBlock(): string {
  return `
botfleet_install_zsh_shell() {
  id -u ${DESKTOP_USER} >/dev/null 2>&1 || { echo "the zsh login shell needs the ${DESKTOP_USER} user, which this host does not have" >&2; return 1; }
  zsh_bin="$(command -v zsh)"
  grep -qx "$zsh_bin" /etc/shells || echo "$zsh_bin" >> /etc/shells
  usermod -s "$zsh_bin" ${DESKTOP_USER}
  cat > ${DESKTOP_HOME}/.zshenv <<'EOF'
# Managed by BotFleet.  Read by every zsh, interactive or not, so \`zsh -c\` sees
# the same PATH as bash.  Debian's zsh does not read /etc/profile.d itself.
typeset -U path
for botfleet_profile in /etc/profile.d/botfleet-*.sh(N); do
  [ -r "$botfleet_profile" ] && . "$botfleet_profile"
done
unset botfleet_profile
EOF
  cat > ${DESKTOP_HOME}/.zshrc <<'EOF'
# Managed by BotFleet.  The defaults a Mac's zsh gives you.
HISTFILE="$HOME/.zsh_history"
HISTSIZE=10000
SAVEHIST=10000
setopt APPEND_HISTORY SHARE_HISTORY HIST_IGNORE_DUPS HIST_IGNORE_SPACE
bindkey -e
autoload -Uz compinit && compinit -u
PROMPT='%n@%m %1~ %# '
EOF
  chmod 0644 ${DESKTOP_HOME}/.zshenv ${DESKTOP_HOME}/.zshrc
  # Every recipe above ran as root with HOME=${DESKTOP_HOME}, so installers left
  # root-owned state in the desktop user's home: gcloud's config, turso, the
  # corepack cache and a .bashrc.backup.  The user then cannot write where its
  # own tools expect to, e.g. \`gcloud auth login\` or a pnpm version switch.
  # This runs last among the recipes, in the same layer, so it costs nothing.
  # Only root-owned entries are touched, so nothing else is rewritten.
  find ${DESKTOP_HOME} -xdev -user root -exec chown -h ${DESKTOP_USER}:${DESKTOP_USER} {} +
}
`;
}

function invokeRecipeSteps(tools: VmCliTool[]): string[] {
  const steps: string[] = [];
  const recipes = new Set(tools.map((tool) => tool.recipe).filter(Boolean));
  if (recipes.has("node")) steps.push("botfleet_install_node");
  if (recipes.has("pnpm")) steps.push("botfleet_install_pnpm");
  if (recipes.has("npm_global")) steps.push("botfleet_install_npm_globals");
  if (recipes.has("awscli")) steps.push("botfleet_install_awscli");
  if (recipes.has("gcloud")) steps.push("botfleet_install_gcloud");
  if (recipes.has("gh")) steps.push("botfleet_install_gh");
  if (recipes.has("kubectl")) steps.push("botfleet_install_kubectl");
  if (recipes.has("docker_cli")) steps.push("botfleet_install_docker_cli");
  if (recipes.has("turso")) steps.push("botfleet_install_turso");
  if (recipes.has("deno")) steps.push("botfleet_install_deno");
  if (recipes.has("rustup")) steps.push("botfleet_install_rustup");
  if (recipes.has("pbcopy_shim")) steps.push("botfleet_install_pbcopy_shims");
  if (recipes.has("open_shim")) steps.push("botfleet_install_open_shim");
  if (recipes.has("pinned_binary")) steps.push("botfleet_install_pinned_binaries");
  if (recipes.has("homebrew")) steps.push("botfleet_install_homebrew");
  if (recipes.has("zsh_shell")) steps.push("botfleet_install_zsh_shell");
  if (tools.some((tool) => tool.postInstall === "fd_symlink")) {
    steps.push('ln -sf "$(command -v fdfind || true)" /usr/local/bin/fd || true');
  }
  // Debian names the binary batcat.  Same shape as the fd link above; the
  // verify step is what catches a missing bat, so a failed link is not fatal here.
  if (tools.some((tool) => tool.postInstall === "bat_symlink")) {
    steps.push('ln -sf "$(command -v batcat || true)" /usr/local/bin/bat || true');
  }
  return steps;
}

/** Self-contained bash that installs every tool for one environment. */
export function renderLinuxInstallScript(environment: VmCliEnvironment): string {
  const tools = vmCliToolsForEnvironment(environment);
  const aptPackages = collectAptPackages(tools);
  const recipeFns = recipeBlocks(environment).join("\n");
  const recipeCalls = invokeRecipeSteps(tools).map((call) => `  ${call}`).join("\n");

  return `#!/usr/bin/env bash
# Generated from scripts/computer-vm-cli/manifest.json — do not edit by hand.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export npm_config_update_notifier=false
export npm_config_fund=false
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

${recipeFns}

botfleet_install_apt() {
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends ${aptPackages.join(" ")}
  $SUDO rm -rf /var/lib/apt/lists/*
}

botfleet_install_apt
${recipeCalls}
`;
}

export function renderDockerfileCliInstallRun(environment: VmCliEnvironment): string {
  const body = renderLinuxInstallScript(environment).replace(/^#!.*\n/, "");
  const run = `RUN <<'BOTFLEET_VM_CLI_INSTALL' /bin/bash\n${body}BOTFLEET_VM_CLI_INSTALL\n`;
  return `${run}${rustupImageEnv(environment)}${homebrewImageEnv(environment)}`;
}

/** Docker-level environment for Homebrew.  This is the one that matters for
 * bots: the Local VM runs them with `docker exec -u cua` and no shell init,
 * so neither .bashrc nor .zshenv is ever read.  The profile.d snippet and the
 * dotfiles cover interactive and login shells; this covers everything else.
 *
 * PATH is APPENDED.  /opt/venv/bin and /usr/local/bin stay ahead of it, so a
 * brew formula cannot shadow the pinned node, cua-driver, or the Python venv. */
function homebrewImageEnv(environment: VmCliEnvironment): string {
  const recipes = new Set(
    vmCliToolsForEnvironment(environment).map((tool) => tool.recipe).filter(Boolean),
  );
  if (!recipes.has("homebrew")) return "";
  return `ENV HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1
ENV PATH=$PATH:${HOMEBREW_PREFIX}/bin:${HOMEBREW_PREFIX}/sbin
`;
}

/** rustup's shims resolve the active toolchain through RUSTUP_HOME.  The
 * install recipe exports it, but only for the length of that recipe, so a
 * later image layer — and every shell in the running container — inherited
 * nothing and `cargo --version` answered "rustup could not choose a version
 * of cargo to run".  Baking it into the image with ENV is what makes the
 * install persist past the RUN that performed it.
 *
 * CARGO_HOME is deliberately NOT baked in, and this is load-bearing rather
 * than tidiness.  Cargo resolves config.toml and credentials.toml *under*
 * CARGO_HOME rather than extending $HOME/.cargo, and the manifest syncs the
 * cargo credentialPaths to /home/cua/.cargo.  Overriding it would point the
 * lookup at a root-owned directory, so private-registry tokens would be
 * ignored and `cargo login` would fail with EACCES as cua.  Only RUSTUP_HOME
 * is needed for the shims; verified: with RUSTUP_HOME alone, cargo and rustc
 * both report 1.99.0. */
function rustupImageEnv(environment: VmCliEnvironment): string {
  const recipes = new Set(
    vmCliToolsForEnvironment(environment).map((tool) => tool.recipe).filter(Boolean),
  );
  if (!recipes.has("rustup")) return "";
  return `ENV ${RUSTUP_HOME_KEY}=${RUSTUP_HOME_DIR}\n`;
}

export function manifestPayloadBase64(): string {
  return Buffer.from(JSON.stringify(loadVmCliManifest()), "utf8").toString("base64");
}

export function renderVerifyScript(environment: VmCliEnvironment): string {
  const tools = vmCliInstallableTools(environment);
  const lines = tools.map((tool) => {
    const verify = tool.verify;
    if (!verify) return `  : # skip verify for ${tool.name}`;
    if (tool.recipe === "pbcopy_shim") {
      return `  if ! command -v ${verify.command} >/dev/null 2>&1; then missing="$missing ${tool.name}"; fi`;
    }
    const args = (verify.args ?? []).map((arg) => shellQuote(arg)).join(" ");
    const cmd = args.length > 0 ? `${verify.command} ${args}` : verify.command;
    return `  if ! ${cmd} >/dev/null 2>&1; then missing="$missing ${tool.name}"; fi`;
  });
  return `#!/usr/bin/env bash
set -euo pipefail
missing=""
${lines.join("\n")}
if [ -n "$missing" ]; then
  echo "missing VM CLIs:$missing" >&2
  exit 1
fi
echo "all $((${tools.length})) VM CLIs present for ${environment}"
`;
}

export function vmCliManifestDigest(): string {
  return createHash("sha256").update(JSON.stringify(loadVmCliManifest())).digest("hex");
}

/** The verify layer runs as root with HOME=/home/cua, and several tools write
 * state under $HOME on their first run, even for --version: pm2 (~/.pm2),
 * wrangler (~/.config/.wrangler), mise (~/.cache/mise).  That left root-owned
 * directories in the desktop user's home, and the first real use by cua died
 * with EACCES.  Hand back only what root created, in the same layer, so the
 * layer does not duplicate the rest of the home.
 *
 * The verify script itself deliberately keeps the real HOME: pnpm resolves its
 * corepack cache through it, so a throwaway HOME makes pnpm read as missing.
 * Run `botfleet-vm-cli-verify` as cua, not root, in a live VM for the same reason. */
function handBackDesktopHome(): string {
  return `find ${DESKTOP_HOME} -xdev -user root -exec chown -h ${DESKTOP_USER}:${DESKTOP_USER} {} +`;
}

export function renderDockerfileVerifyArtifacts(environment: VmCliEnvironment): string {
  // Keep the shebang here, unlike the install body above.  The install script is
  // piped to an explicit `/bin/bash`, so its shebang would only be a comment.
  // This one is written to a file and executed directly, and with the shebang
  // gone the kernel falls back to /bin/sh, which is dash on Debian and rejects
  // `set -o pipefail`.  That failed the image build at the verify step on
  // 2026-10-06, after every CLI had already installed correctly.
  const verifyBody = renderVerifyScript(environment);
  return `RUN mkdir -p /etc/botfleet && printf '%s' '${manifestPayloadBase64()}' | base64 -d > /etc/botfleet/vm-cli-manifest.json
RUN <<'BOTFLEET_VM_CLI_VERIFY_BIN' cat > /usr/local/bin/botfleet-vm-cli-verify
${verifyBody}BOTFLEET_VM_CLI_VERIFY_BIN
RUN chmod 0755 /usr/local/bin/botfleet-vm-cli-verify && /usr/local/bin/botfleet-vm-cli-verify && ${handBackDesktopHome()}
`;
}

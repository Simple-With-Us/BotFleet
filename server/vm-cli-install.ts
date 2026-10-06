import { createHash } from "node:crypto";

import {
  collectAptPackages,
  loadVmCliManifest,
  vmCliInstallableTools,
  vmCliToolsForEnvironment,
  type VmCliEnvironment,
  type VmCliTool,
} from "./vm-cli-manifest.ts";

const NODE_VERSION = "24.11.0";
const PNPM_VERSION = "10.33.0";
const GH_VERSION = "2.63.2";
const KUBECTL_VERSION = "1.32.0";
const DOCKER_CLI_VERSION = "27.4.1";
const DENO_VERSION = "2.2.0";
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

  return blocks;
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
  if (tools.some((tool) => tool.postInstall === "fd_symlink")) {
    steps.push('ln -sf "$(command -v fdfind || true)" /usr/local/bin/fd || true');
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
  return `${run}${rustupImageEnv(environment)}`;
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
RUN chmod 0755 /usr/local/bin/botfleet-vm-cli-verify && /usr/local/bin/botfleet-vm-cli-verify
`;
}
